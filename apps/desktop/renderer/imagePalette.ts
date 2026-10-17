import { useEffect, useState } from 'react';
import { luminance, mix } from './companionPalette';

export interface BackgroundSample {
  average: string;
  light: boolean;
  bubble: string;
  chrome: string;
  scrim: string;
  scrimTop: string;
  scrimBottom: string;
}

function samplePalette(average: string): BackgroundSample {
  const light = luminance(average) >= .5;
  return {
    average,
    light,
    bubble: light ? mix(average, '#fffaf3', .86) : mix('#14181b', average, .22),
    chrome: mix('#121619', average, light ? .08 : .15),
    scrim: light ? 'rgba(8, 12, 16, .05)' : 'rgba(8, 12, 16, .02)',
    scrimTop: light ? 'rgba(8, 12, 16, .46)' : 'rgba(8, 12, 16, .32)',
    scrimBottom: light ? 'rgba(8, 12, 16, .28)' : 'rgba(8, 12, 16, .22)',
  };
}

async function readAverage(url: string): Promise<BackgroundSample | null> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.decoding = 'async';
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('background image unavailable'));
  });
  image.src = url;
  await loaded;
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(image, 0, 0, size, size);
  } catch {
    return null;
  }
  let data: Uint8ClampedArray;
  try {
    data = context.getImageData(0, 0, size, size).data;
  } catch {
    return null;
  }
  let red = 0, green = 0, blue = 0, total = 0;
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] / 255;
    if (alpha < .25) continue;
    red += data[index] * alpha;
    green += data[index + 1] * alpha;
    blue += data[index + 2] * alpha;
    total += alpha;
  }
  if (!total) return null;
  const channels = [red, green, blue].map(channel => Math.round(channel / total));
  const average = '#' + channels.map(channel => channel.toString(16).padStart(2, '0')).join('');
  return samplePalette(average);
}

const cache = new Map<string, Promise<BackgroundSample | null>>();

export function sampleBackground(url: string) {
  const cached = cache.get(url);
  if (cached) return cached;
  const request = readAverage(url).catch(() => null);
  cache.set(url, request);
  if (cache.size > 8) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return request;
}

export function useImagePalette(enabled: boolean, imageId: string, revision: number) {
  const [sample, setSample] = useState<BackgroundSample | null>(null);
  useEffect(() => {
    let active = true;
    if (!enabled || !imageId) {
      setSample(null);
      return;
    }
    const url = `ayana-background://custom/?image=${encodeURIComponent(imageId)}&v=${revision}`;
    void sampleBackground(url).then(value => { if (active) setSample(value); });
    return () => { active = false; };
  }, [enabled, imageId, revision]);
  return sample;
}
