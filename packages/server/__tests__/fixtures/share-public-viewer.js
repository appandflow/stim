'use strict';

/** Makes the viewer's WebRTC offer carry only a public address, as a viewer on the internet's would to a sender on a LAN. */
(() => {
  const original = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, 'localDescription');
  Object.defineProperty(RTCPeerConnection.prototype, 'localDescription', {
    configurable: true,
    get() {
      const description = original.get.call(this);
      if (!description) return description;
      const sdp = description.sdp.replace(
        /^(a=candidate:\S+ \d+ \S+ \d+ )\S+( \d+ typ )host/gm,
        '$1203.0.113.9$2srflx',
      );
      return { type: description.type, sdp };
    },
  });
})();
