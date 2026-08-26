const fetch = require('node-fetch');
const FormData = require('form-data');

const API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_sts_v2';

// Wrap raw PCM16 samples in a minimal WAV header so ElevenLabs can read it.
function pcm16ToWav(int16arr, sampleRate) {
  const dataLength = int16arr.length * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  Buffer.from(int16arr.buffer, int16arr.byteOffset, dataLength).copy(buffer, 44);
  return buffer;
}

/**
 * Send a chunk of the user's (impaired) speech to ElevenLabs Speech-to-Speech
 * and get back clear audio already encoded as ulaw_8000 -- the exact format
 * Twilio expects, so no further conversion is needed before sending it to the call.
 */
async function convertToClearVoice(int16arr, sampleRate) {
  const wavBuffer = pcm16ToWav(int16arr, sampleRate);

  const form = new FormData();
  form.append('audio', wavBuffer, { filename: 'chunk.wav', contentType: 'audio/wav' });
  form.append('model_id', MODEL_ID);
  form.append('output_format', 'ulaw_8000');

  const resp = await fetch(`https://api.elevenlabs.io/v1/speech-to-speech/${VOICE_ID}`, {
    method: 'POST',
    headers: { 'xi-api-key': API_KEY, ...form.getHeaders() },
    body: form,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ElevenLabs error ${resp.status}: ${text}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

module.exports = { convertToClearVoice };
