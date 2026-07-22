/**
 * Speech detection and level conditioning for 16 kHz mono PCM.
 *
 * Everything here is classical DSP on purpose. Whisper is trained on messy
 * real-world audio and generally copes with noise better than it copes with the
 * artefacts of aggressive cleanup, so this module deliberately does *not*
 * denoise. It only fixes the two things that measurably hurt recognition of
 * dictaphone recordings — inaudible level and low-frequency rumble — and finds
 * the pauses, so windows can be cut where nobody is speaking.
 */

const SAMPLE_RATE = 16_000;
const FRAME_MS = 20;
const FRAME_SIZE = (SAMPLE_RATE * FRAME_MS) / 1000;

/** Target level for normalization, in dBFS RMS. Comfortably below clipping. */
const TARGET_RMS_DBFS = -20;
const PEAK_CEILING = 0.97;

function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

/**
 * Removes DC offset and rumble below ~80 Hz.
 *
 * Cheap phone and dictaphone capsules add both: a constant bias and handling
 * noise that carries real energy but no speech. Left alone it inflates the
 * frame energies that voice detection relies on, and it wastes headroom that
 * normalization would rather give to the voice.
 *
 * One-pole high-pass, applied in place.
 */
export function highPassFilter(samples: Float32Array, cutoffHz = 80): void {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / SAMPLE_RATE;
  const alpha = rc / (rc + dt);

  let previousInput = samples[0] ?? 0;
  let previousOutput = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const input = samples[i];
    previousOutput = alpha * (previousOutput + input - previousInput);
    previousInput = input;
    samples[i] = previousOutput;
  }
}

/** Per-frame RMS, the basis for both the level and the speech decisions. */
function frameEnergies(samples: Float32Array): Float32Array {
  const frameCount = Math.max(1, Math.floor(samples.length / FRAME_SIZE));
  const energies = new Float32Array(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * FRAME_SIZE;
    let sum = 0;
    for (let i = start; i < start + FRAME_SIZE && i < samples.length; i += 1) {
      sum += samples[i] * samples[i];
    }
    energies[frame] = Math.sqrt(sum / FRAME_SIZE);
  }

  return energies;
}

/**
 * Speech level, estimated as a high percentile of frame energy.
 *
 * A plain overall RMS is dragged down by pauses, so a recording that is mostly
 * silence would be amplified far too much. The 90th percentile tracks the
 * loudness of the speech itself.
 */
function speechLevel(energies: Float32Array): number {
  if (energies.length === 0) return 0;
  const sorted = Float32Array.from(energies).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
}

/**
 * Brings quiet recordings up to a usable level, in place.
 *
 * Gain is capped so that near-silence is not amplified into noise, and the peak
 * is limited so nothing clips. Returns the gain applied, for diagnostics.
 */
export function normalizeLevel(samples: Float32Array, maxGain = 12): number {
  const energies = frameEnergies(samples);
  const level = speechLevel(energies);
  if (level <= 1e-5) return 1;

  const target = dbToLinear(TARGET_RMS_DBFS);
  let gain = Math.min(maxGain, target / level);
  if (gain <= 1.01) return 1;

  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  if (peak * gain > PEAK_CEILING) {
    gain = PEAK_CEILING / peak;
  }
  if (gain <= 1.01) return 1;

  for (let i = 0; i < samples.length; i += 1) {
    samples[i] *= gain;
  }
  return gain;
}

/**
 * Whether the buffer contains anything worth transcribing.
 *
 * Feeding Whisper silence is not merely wasteful: with nothing to transcribe it
 * invents text, and on Russian audio the invention is often a stray subtitle
 * credit repeated to fill the window. Skipping silent windows removes that
 * failure mode at the source.
 *
 * The threshold is relative to the loudest part of the window, so it adapts to
 * quiet recordings instead of assuming a fixed floor.
 */
export function containsSpeech(samples: Float32Array): boolean {
  const energies = frameEnergies(samples);
  if (energies.length === 0) return false;

  const level = speechLevel(energies);
  // Nothing in the window rises above the noise floor of a normal room.
  if (level < 0.002) return false;

  const threshold = Math.max(level * 0.25, 0.0015);
  let voiced = 0;
  for (let i = 0; i < energies.length; i += 1) {
    if (energies[i] >= threshold) voiced += 1;
  }

  // At least ~150 ms of voiced frames, and some proportion of the window.
  return voiced >= 8 && voiced / energies.length >= 0.02;
}

/**
 * Finds the quietest instant near a proposed cut point.
 *
 * Cutting on a timer lands mid-word about as often as not, and both windows
 * then start or end on half a syllable that the model has to guess at. Moving
 * the cut to the nearest pause costs nothing and removes a whole class of
 * garbled seams.
 *
 * Returns a sample offset within `samples`, searching `toleranceSeconds` either
 * side of `preferredOffset`.
 */
export function findQuietestCut(
  samples: Float32Array,
  preferredOffset: number,
  toleranceSeconds = 1.5,
): number {
  const tolerance = Math.floor(toleranceSeconds * SAMPLE_RATE);
  const from = Math.max(0, preferredOffset - tolerance);
  const to = Math.min(samples.length, preferredOffset + tolerance);
  if (to - from < FRAME_SIZE * 2) return preferredOffset;

  let bestOffset = preferredOffset;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let start = from; start + FRAME_SIZE <= to; start += FRAME_SIZE) {
    let sum = 0;
    for (let i = start; i < start + FRAME_SIZE; i += 1) {
      sum += samples[i] * samples[i];
    }
    const energy = Math.sqrt(sum / FRAME_SIZE);
    // Prefer quiet, and among equally quiet points prefer the one closest to
    // where the cut was meant to be — windows should stay near their intended
    // length.
    const distancePenalty = Math.abs(start - preferredOffset) / (tolerance || 1);
    const score = energy * (1 + distancePenalty * 0.35);

    if (score < bestScore) {
      bestScore = score;
      bestOffset = start;
    }
  }

  return bestOffset;
}

/**
 * Conditions a decoded window in place: rumble out, level up.
 *
 * Applied to every buffer before it reaches the model, so the file path and the
 * microphone path get identical treatment.
 */
export function conditionForRecognition(samples: Float32Array): { gain: number } {
  highPassFilter(samples);
  const gain = normalizeLevel(samples);
  return { gain };
}
