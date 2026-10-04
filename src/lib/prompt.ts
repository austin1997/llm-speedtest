const instruction = 'Read the following benchmark records. Write a detailed numbered analysis of their patterns, trade-offs, and practical recommendations. Keep expanding the analysis with concrete examples until the response budget is reached. Do not simply acknowledge this request.\n\n';
const records = [
  'A coastal research station records wind speed, air temperature, and tidal changes. Its instruments operate continuously, while technicians compare observations at regular intervals to identify long-term patterns.',
  'A regional delivery network balances travel distance, vehicle capacity, and promised arrival times. Shorter routes can reduce fuel use, but combining deliveries can improve overall efficiency even when individual trips take longer.',
  'A public library organizes technical books, historical documents, and community workshops. Visitors value both quick access to familiar material and opportunities to discover topics beyond their original questions.',
  'A software team measures response latency, resource usage, and failure rates before selecting a deployment configuration. Higher throughput is useful only when the service also meets its reliability and latency requirements.',
  'An urban garden uses soil measurements and weather forecasts to choose irrigation schedules. Conserving water requires attention to plant growth, seasonal variation, and the delay between a decision and its observable effects.',
  'A renewable energy operator matches variable production with changing demand. Storage improves flexibility, while forecasting helps reserve capacity for periods when generation and consumption move in opposite directions.',
  'A training program combines short exercises, detailed feedback, and opportunities for independent practice. Repetition can improve speed, but varied examples are necessary to test whether knowledge transfers to unfamiliar situations.',
  'A manufacturing line tracks queue lengths, inspection results, and equipment downtime. Adding parallel stations can increase capacity, although shared materials and downstream bottlenecks may limit the final improvement.',
];

/** Deliberately model-independent: ASCII ~4 chars/token, other characters ~1.5. */
export function tokenWeight(text: string): number {
  let weight = 0;
  for (const char of text) weight += char.codePointAt(0)! < 128 ? 0.25 : 2 / 3;
  return weight;
}

export function estimateTokens(text: string): number { return Math.ceil(tokenWeight(text)); }

export function generatePrompt(tokens: number): string {
  const size = Math.max(128, Math.min(32768, Math.round(tokens))) * 4;
  let text = instruction;
  for (let i = 0; text.length < size; i++) text += `Record ${i + 1}: ${records[i % records.length]}\n\n`;
  return text.slice(0, size);
}

export function autoContext(input: number, output: number): number {
  return Math.max(4096, Math.ceil((input + output + 512) / 1024) * 1024);
}
