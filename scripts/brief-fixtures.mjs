import fs from 'node:fs';
import { summarize, refine } from '../apps/tablet/src/core/summary/engine.js';
const files = fs.readdirSync(new URL('../spec/fixtures/', import.meta.url)).filter(f => f.endsWith('.json')).sort();
const output = [];
for (const file of files) {
  const fixture = JSON.parse(fs.readFileSync(new URL(`../spec/fixtures/${file}`, import.meta.url), 'utf8'));
  const first = await summarize(fixture.source);
  const second = first.status === 'OK' ? await refine(first, { text: fixture.source }) : null;
  output.push({ id: fixture.id, status: first.status, body: first.body, stage2Status: second?.status ?? null, stage2Body: second?.body ?? null });
}
process.stdout.write(JSON.stringify(output));
