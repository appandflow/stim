'use strict';

(() => {
  const probe = { draws: 0, socketVideo: 0, peers: 0, log: [] };
  const peers = [];
  probe.killPeers = () => peers.forEach((peer) => peer.close());
  window.shareProbe = probe;
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...args) {
    probe.draws++;
    return draw.apply(this, args);
  };
  const Socket = window.WebSocket;
  window.WebSocket = class extends Socket {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer && new Uint8Array(event.data, 0, 1)[0] === 1) probe.socketVideo++;
      });
    }
  };
  const Peer = window.RTCPeerConnection;
  if (Peer) {
    window.RTCPeerConnection = class extends Peer {
      constructor(...args) {
        super(...args);
        peers.push(this);
        probe.peers++;
      }
    };
  }
  new MutationObserver(() => {
    const body = document.body;
    const phase = body.dataset.transport + '/' + body.dataset.rtcPhase;
    if (!probe.log.length || probe.log[probe.log.length - 1].phase !== phase)
      probe.log.push({ phase, draws: probe.draws, socketVideo: probe.socketVideo });
  }).observe(document, {
    attributes: true,
    subtree: true,
    attributeFilter: ['data-transport', 'data-rtc-phase'],
  });
})();
