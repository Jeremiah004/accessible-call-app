// Minimal G.711 mu-law <-> 16-bit PCM codec.
// Twilio Media Streams send/receive audio as 8kHz mu-law. We decode incoming
// audio to PCM16 (so we can measure volume for pause detection and, if
// needed, forward it to the browser) and can encode PCM16 back to mu-law.

const BIAS = 0x84;
const CLIP = 32635;

function linearToMulaw(sampleIn) {
  let sample = sampleIn;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
    // find exponent
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const mulawByte = ~(sign | (exponent << 4) | mantissa);
  return mulawByte & 0xff;
}

function mulawToLinear(mulawByteIn) {
  const mulawByte = ~mulawByteIn & 0xff;
  const sign = mulawByte & 0x80;
  const exponent = (mulawByte >> 4) & 0x07;
  const mantissa = mulawByte & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign !== 0 ? -sample : sample;
}

function decodeMulawBuffer(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = mulawToLinear(buf[i]);
  return out;
}

function encodeMulawBuffer(int16arr) {
  const out = Buffer.alloc(int16arr.length);
  for (let i = 0; i < int16arr.length; i++) out[i] = linearToMulaw(int16arr[i]);
  return out;
}

module.exports = { decodeMulawBuffer, encodeMulawBuffer, mulawToLinear, linearToMulaw };
