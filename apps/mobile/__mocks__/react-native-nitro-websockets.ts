export function createWebSocket(): never {
  throw new Error('Jest has no native WebSocket. Pass the connection a createSocket factory.');
}
