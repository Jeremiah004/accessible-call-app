require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const twilio = require('twilio');
const { decodeMulawBuffer } = require('./mulaw');
const { convertToClearVoice } = require('./elevenlabs');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use((req, res, next) => {
  // very permissive CORS for the PWA -- tighten this to your real domain once deployed
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3000;
const PUBLIC_HOST = process.env.PUBLIC_HOST;
const APP_SHARED_SECRET = process.env.APP_SHARED_SECRET;
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// sessionId -> { pwaSocket, twilioSocket, streamSid, userBuffer[], userBufferMs, silenceMs }
const sessions = new Map();

function newSessionId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function requireSecret(req, res, next) {
  const provided = req.headers['authorization'];
  if (!APP_SHARED_SECRET || provided !== `Bearer ${APP_SHARED_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ---------------------------------------------------------------------------
// 1. PWA calls this to start an outbound call to the doctor/bank/family member
// ---------------------------------------------------------------------------
app.post('/call', requireSecret, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'missing "to" phone number' });

  const sessionId = newSessionId();
  sessions.set(sessionId, {
    pwaSocket: null,
    twilioSocket: null,
    streamSid: null,
    userBuffer: [],
    userBufferMs: 0,
    silenceMs: 0,
  });

  try {
    const call = await twilioClient.calls.create({
      to,
      from: process.env.TWILIO_FROM_NUMBER,
      url: `https://${PUBLIC_HOST}/twiml?session=${sessionId}`,
    });
    res.json({ sessionId, callSid: call.sid });
  } catch (err) {
    sessions.delete(sessionId);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 2. Twilio fetches this once the call connects, to learn what to do with it
// ---------------------------------------------------------------------------
app.post('/twiml', (req, res) => {
  const sessionId = req.query.session;
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({
    url: `wss://${PUBLIC_HOST}/twilio-stream?session=${sessionId}`,
    track: 'both_tracks',
  });
  res.type('text/xml').send(twiml.toString());
});

app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === '/twilio-stream') {
      handleTwilioSocket(ws, url.searchParams.get('session'));
    } else if (url.pathname === '/pwa-stream') {
      handlePwaSocket(ws, url.searchParams.get('session'), url.searchParams.get('secret'));
    } else {
      ws.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Twilio side: receives the destination's audio, relays it to the PWA;
// also the channel we push converted user audio INTO (to play to destination)
// ---------------------------------------------------------------------------
function handleTwilioSocket(ws, sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return ws.close();
  session.twilioSocket = ws;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.event === 'start') {
      session.streamSid = msg.start.streamSid;
      notifyPwa(session, { type: 'status', status: 'connected' });
    } else if (msg.event === 'media' && msg.media.track === 'inbound') {
      // Audio FROM the doctor/bank -> decode and forward to the PWA to play
      const mulawBuf = Buffer.from(msg.media.payload, 'base64');
      const pcm16 = decodeMulawBuffer(mulawBuf);
      if (session.pwaSocket && session.pwaSocket.readyState === 1) {
        session.pwaSocket.send(Buffer.from(pcm16.buffer));
      }
    } else if (msg.event === 'stop') {
      notifyPwa(session, { type: 'status', status: 'ended' });
      cleanupSession(sessionId);
    }
  });

  ws.on('close', () => cleanupSession(sessionId));
}

// ---------------------------------------------------------------------------
// PWA side: receives the user's mic audio (raw PCM16 @ 16kHz binary frames),
// buffers by pause detection, sends chunks to ElevenLabs, forwards result
// into the Twilio stream so the destination hears the converted voice.
// ---------------------------------------------------------------------------
const SAMPLE_RATE = 16000;
const SILENCE_RMS_THRESHOLD = 400; // tune per user during onboarding/calibration
const SILENCE_HANG_MS = 500;
const MIN_CHUNK_MS = 400;
const MAX_CHUNK_MS = 4000;

function handlePwaSocket(ws, sessionId, secret) {
  if (secret !== APP_SHARED_SECRET) return ws.close();
  const session = sessions.get(sessionId);
  if (!session) return ws.close();
  session.pwaSocket = ws;

  ws.on('message', (raw) => {
    const int16 = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
    session.userBuffer.push(int16);
    session.userBufferMs += (int16.length / SAMPLE_RATE) * 1000;

    const level = rms(int16);
    session.silenceMs =
      level < SILENCE_RMS_THRESHOLD ? session.silenceMs + (int16.length / SAMPLE_RATE) * 1000 : 0;

    const shouldFlush =
      (session.userBufferMs >= MIN_CHUNK_MS && session.silenceMs >= SILENCE_HANG_MS) ||
      session.userBufferMs >= MAX_CHUNK_MS;

    if (shouldFlush) {
      const chunk = concatInt16(session.userBuffer);
      session.userBuffer = [];
      session.userBufferMs = 0;
      session.silenceMs = 0;
      flushChunkToDestination(session, chunk).catch((err) =>
        console.error('[conversion error]', err.message)
      );
    }
  });

  ws.on('close', () => {
    session.pwaSocket = null;
  });
}

async function flushChunkToDestination(session, pcm16Chunk) {
  if (!session.streamSid) return; // Twilio leg isn't connected yet
  const ulawBytes = await convertToClearVoice(pcm16Chunk, SAMPLE_RATE);
  const payload = ulawBytes.toString('base64');
  if (session.twilioSocket && session.twilioSocket.readyState === 1) {
    session.twilioSocket.send(
      JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload } })
    );
  }
}

function notifyPwa(session, obj) {
  if (session.pwaSocket && session.pwaSocket.readyState === 1) {
    session.pwaSocket.send(JSON.stringify(obj));
  }
}

function rms(int16arr) {
  let sum = 0;
  for (let i = 0; i < int16arr.length; i++) sum += int16arr[i] * int16arr[i];
  return Math.sqrt(sum / int16arr.length);
}

function concatInt16(chunks) {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function cleanupSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  try { session.twilioSocket?.close(); } catch {}
  try { session.pwaSocket?.close(); } catch {}
  sessions.delete(sessionId);
}

server.listen(PORT, () => console.log(`Backend listening on :${PORT}`));
