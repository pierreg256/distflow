#!/usr/bin/env node

import { PMD } from './pmd';

const args = process.argv.slice(2);

// Parse arguments
let port = 4369;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && i + 1 < args.length) {
    port = parseInt(args[i + 1], 10);
  }
}

// Start PMD
const pmd = new PMD({ port });

pmd.start().then(() => {
  console.log(`PMD started on port ${port}`);
}).catch((err) => {
  console.error('Failed to start PMD:', err);
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down PMD...');
  await pmd.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down PMD...');
  await pmd.stop();
  process.exit(0);
});
