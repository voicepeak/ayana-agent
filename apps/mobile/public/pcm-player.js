/* One sample-clock consumer. The chat renderer is its only host. */
class AyanaPcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.cancelledGeneration = -1;
    this.progressFrames = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'cancel') {
        this.cancelledGeneration = Math.max(this.cancelledGeneration, data.generation_id);
        this.queue = this.queue.filter(item => item.generation_id > this.cancelledGeneration);
        if (this.current && this.current.generation_id <= this.cancelledGeneration) {
          this.receipt('cancelled', this.current, true);
          this.current = null;
        }
      } else if (data.type === 'enqueue' && data.generation_id > this.cancelledGeneration) {
        this.queue.push({ ...data, position: 0 });
      }
    };
  }
  receipt(type, item, cancelled = false) {
    this.port.postMessage({
      type, utterance_id: item.utterance_id, generation_id: item.generation_id,
      played_samples: Math.min(item.samples.length, Math.floor(item.position)),
      total_samples: item.samples.length, sample_rate: item.sample_rate, cancelled,
    });
  }
  process(_inputs, outputs) {
    const output = outputs[0][0];
    for (let frame = 0; frame < output.length; frame++) {
      if (!this.current && this.queue.length) {
        this.current = this.queue.shift();
        if (this.current.generation_id <= this.cancelledGeneration) { this.current = null; frame--; continue; }
        this.receipt('started', this.current);
      }
      const item = this.current;
      if (!item) { output[frame] = 0; continue; }
      const index = Math.floor(item.position);
      const fraction = item.position - index;
      const first = item.samples[index] || 0;
      const second = item.samples[Math.min(index + 1, item.samples.length - 1)] || 0;
      output[frame] = first + (second - first) * fraction;
      item.position += item.sample_rate / sampleRate;
      if (item.position >= item.samples.length) {
        item.position = item.samples.length;
        this.receipt('ended', item);
        this.current = null;
      }
    }
    this.progressFrames += output.length;
    if (this.current && this.progressFrames >= sampleRate / 10) {
      this.receipt('progress', this.current);
      this.progressFrames = 0;
    }
    return true;
  }
}
registerProcessor('ayana-pcm-player', AyanaPcmPlayer);
