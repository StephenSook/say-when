/** Raw, headerless PCM encodings this package reads and writes. Both are in the TTS output and STT input enums. */
export type PcmEncoding = 'pcm_s16le' | 'pcm_f32le';

const BYTES: Readonly<Record<PcmEncoding, number>> = { pcm_s16le: 2, pcm_f32le: 4 };

export const bytesPerSample = (encoding: PcmEncoding): number => BYTES[encoding];

/** Decodes a TTS chunk's base64 `data` field. */
export function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
    let length = 0;
    for (const part of parts) length += part.byteLength;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}

/** Length of mono raw PCM in milliseconds, from its byte count. A trailing partial sample is not counted. */
export function pcmDurationMs(byteLength: number, encoding: PcmEncoding, sampleRate: number): number {
    const frames = Math.floor(byteLength / BYTES[encoding]);
    return Math.round((frames * 1000) / sampleRate);
}

/** Little-endian PCM bytes to Web Audio floats in -1 to 1. */
export function pcmToFloat32(bytes: Uint8Array, encoding: PcmEncoding): Float32Array {
    const size = BYTES[encoding];
    const frames = Math.floor(bytes.byteLength / size);
    const view = new DataView(bytes.buffer, bytes.byteOffset, frames * size);
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
        out[i] = encoding === 'pcm_s16le' ? view.getInt16(i * 2, true) / 32768 : view.getFloat32(i * 4, true);
    }
    return out;
}

/** Web Audio floats to 16-bit little-endian PCM, clamped to -1 to 1. */
export function floatToPcm16(samples: Float32Array): Uint8Array {
    const out = new Uint8Array(samples.length * 2);
    const view = new DataView(out.buffer);
    for (let i = 0; i < samples.length; i++) {
        const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
        view.setInt16(i * 2, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true);
    }
    return out;
}

/**
 * Averaging downsampler that keeps its place between blocks, so 128-frame AudioWorklet blocks do not drift.
 * Cartesia's audio input guide notes speech gains little above 16 kHz.
 */
export class Downsampler {
    private carry = new Float32Array(0);
    private offset = 0;
    private readonly ratio: number;

    constructor(fromRate: number, toRate: number) {
        if (!(fromRate > 0 && toRate > 0) || toRate > fromRate) throw new RangeError('Downsampler only lowers the sample rate.');
        this.ratio = fromRate / toRate;
    }

    push(input: Float32Array): Float32Array {
        const buffer = new Float32Array(this.carry.length + input.length);
        buffer.set(this.carry);
        buffer.set(input, this.carry.length);
        const out: number[] = [];
        let start = this.offset;
        while (start + this.ratio <= buffer.length) {
            const from = Math.floor(start);
            const to = Math.max(from + 1, Math.floor(start + this.ratio));
            let sum = 0;
            for (let j = from; j < to; j++) sum += buffer[j] ?? 0;
            out.push(sum / (to - from));
            start += this.ratio;
        }
        const keep = Math.floor(start);
        this.carry = buffer.slice(keep);
        this.offset = start - keep;
        return Float32Array.from(out);
    }
}

/** Cuts a byte stream into fixed-size chunks, for example 100 ms of audio as the STT docs suggest. */
export class PcmChunker {
    private parts: Uint8Array[] = [];
    private size = 0;

    constructor(private readonly chunkBytes: number) {
        if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) throw new RangeError('chunkBytes must be a positive integer.');
    }

    push(bytes: Uint8Array): Uint8Array[] {
        this.parts.push(bytes);
        this.size += bytes.byteLength;
        if (this.size < this.chunkBytes) return [];
        let all = concatBytes(this.parts);
        const out: Uint8Array[] = [];
        while (all.byteLength >= this.chunkBytes) {
            out.push(all.slice(0, this.chunkBytes));
            all = all.subarray(this.chunkBytes);
        }
        this.parts = all.byteLength > 0 ? [all.slice()] : [];
        this.size = all.byteLength;
        return out;
    }

    /** Whatever is left, possibly shorter than a chunk. */
    flush(): Uint8Array {
        const rest = concatBytes(this.parts);
        this.parts = [];
        this.size = 0;
        return rest;
    }
}
