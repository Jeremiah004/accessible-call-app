const { BACKEND_HTTP, BACKEND_WS, APP_SHARED_SECRET } = window.APP_CONFIG;

const callBtn = document.getElementById('callBtn');
const hangupBtn = document.getElementById('hangupBtn');
const numberInput = document.getElementById('number');
const statusEl = document.getElementById('status');
const micLevelBar = document.getElementById('micLevelBar');

let audioCtx = null;
let micStream = null;
let sourceNode = null;
let processorNode = null;
let ws = null;
let playbackCtx = null;

const TARGET_SAMPLE_RATE = 16000; // what we send to the backend
const DEST_SAMPLE_RATE = 8000;    // what we receive back (decoded from Twilio's mulaw)

function setStatus(text) {
  statusEl.textContent = text;
}

// Downsample Float32 audio from the mic's native rate to 16kHz Int16 PCM.
function downsampleTo16kInt16(float32Input, inputSampleRate) {
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.floor(float32Input.length / ratio);
  const output = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = Math.floor(i * ratio);
    let sample = float32Input[srcIndex];
    sample = Math.max(-1, Math.min(1, sample));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

async function startCall() {
  const to = numberInput.value.trim();
  if (!to) {
    setStatus('Enter a number first.');
    return;
  }

  callBtn.disabled = true;
  setStatus('Requesting microphone access...');

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setStatus('Microphone permission denied.');
    callBtn.disabled = false;
    return;
  }

  setStatus('Starting call...');

  // 1. Ask the backend to place the outbound Twilio call
  let sessionId;
  try {
    const resp = await fetch(`${BACKEND_HTTP}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${APP_SHARED_SECRET}`,
      },
      body: JSON.stringify({ to }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'call failed');
    sessionId = data.sessionId;
  } catch (err) {
    setStatus(`Could not start call: ${err.message}`);
    callBtn.disabled = false;
    stopMic();
    return;
  }

  // 2. Open the audio WebSocket for this session
  ws = new WebSocket(
    `${BACKEND_WS}/pwa-stream?session=${sessionId}&secret=${encodeURIComponent(APP_SHARED_SECRET)}`
  );
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    setStatus('Dialing...');
    hangupBtn.disabled = false;
  };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);
      if (msg.type === 'status') {
        if (msg.status === 'connected') setStatus('Connected -- speak normally.');
        if (msg.status === 'ended') {
          setStatus('Call ended.');
          endCall();
        }
      }
      return;
    }
    // Binary message: PCM16 @ 8kHz audio from the person we called
    playIncomingAudio(new Int16Array(event.data));
  };

  ws.onclose = () => {
    if (statusEl.textContent !== 'Call ended.') setStatus('Disconnected.');
    endCall();
  };

  // 3. Start streaming mic audio to the backend
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioCtx.createMediaStreamSource(micStream);
  processorNode = audioCtx.createScriptProcessor(2048, 1, 1);

  processorNode.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const level = Math.sqrt(input.reduce((s, v) => s + v * v, 0) / input.length);
    micLevelBar.style.width = `${Math.min(100, level * 400)}%`;

    if (ws && ws.readyState === WebSocket.OPEN) {
      const pcm16 = downsampleTo16kInt16(input, audioCtx.sampleRate);
      ws.send(pcm16.buffer);
    }
  };

  sourceNode.connect(processorNode);
  processorNode.connect(audioCtx.destination); // required by some browsers to keep the node alive
}

function playIncomingAudio(int16arr) {
  if (!playbackCtx) {
    playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  const buffer = playbackCtx.createBuffer(1, int16arr.length, DEST_SAMPLE_RATE);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < int16arr.length; i++) {
    channel[i] = int16arr[i] / 0x8000;
  }
  const src = playbackCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(playbackCtx.destination);
  src.start();
}

function stopMic() {
  if (processorNode) processorNode.disconnect();
  if (sourceNode) sourceNode.disconnect();
  if (audioCtx) audioCtx.close();
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  processorNode = sourceNode = audioCtx = micStream = null;
}

function endCall() {
  stopMic();
  if (ws) {
    ws.close();
    ws = null;
  }
  callBtn.disabled = false;
  hangupBtn.disabled = true;
  micLevelBar.style.width = '0%';
}

callBtn.addEventListener('click', startCall);
hangupBtn.addEventListener('click', () => {
  setStatus('Call ended.');
  endCall();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
