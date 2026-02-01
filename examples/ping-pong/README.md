# Ping-Pong Example

Simple example demonstrating fire-and-forget messaging between two nodes.

## Running the example

1. Start the pong node:
```bash
npm run start:pong
```

2. In another terminal, start the ping node:
```bash
npm run start:ping
```

The ping node will send a PING message to the pong node, which will reply with a PONG.

## What's happening

- Both nodes automatically register with the PMD
- The ping node sends a message to the 'pong' alias
- The pong node receives the message and sends a reply
- All communication is fire-and-forget (no synchronous calls)
