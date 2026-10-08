import { chat } from '../services/llmGateway.js';

const model = process.argv[2];

if (!model) {
  console.error('Usage: npm run gateway:test -- <model-id>');
  process.exit(1);
}

console.log(`[1/3] Calling gateway with model "${model}" (model + messages only)...`);

try {
  const result = await chat(model, 'Reply with the single word: ok');
  console.log('[2/3] Call succeeded.');
  console.log('      Reply:', result.choices?.[0]?.message?.content);
  console.log('      Model:', result.model);
  console.log('      Usage:', JSON.stringify(result.usage));
  console.log('[3/3] Done. Check cost at https://platform.experientiallabs.ai/credits');
} catch (error) {
  console.error('[x] Call failed.');
  console.error('    Status:', error.status);
  console.error('    Message:', error.message);
  process.exit(1);
}