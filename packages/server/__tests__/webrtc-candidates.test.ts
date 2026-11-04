import { describe, expect, it } from 'vitest';
import { filterCandidates, privateAddress } from '../src/webrtc-candidates.ts';

/** A Chrome offer for the share viewer's two data channels, after it gathered with a STUN server. */
const CHROME_OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=application 54321 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 203.0.113.9',
  'a=candidate:1 1 udp 2113937151 7c6f1a2e-5b0d-4e0a-9f55-1d3c0b6a2e11.local 54321 typ host generation 0',
  'a=candidate:2 1 udp 1677729535 203.0.113.9 54321 typ srflx raddr 0.0.0.0 rport 0 generation 0',
  'a=candidate:3 1 udp 2113939711 2001:db8:85a3::8a2e:370:7334 54322 typ host generation 0',
  'a=candidate:4 1 tcp 1518280447 192.168.1.20 9 typ host tcptype active generation 0',
  'a=candidate:5 1 udp 2113937150 attacker.example.com 5000 typ host generation 0',
  'a=ice-ufrag:abcd',
  'a=ice-pwd:0123456789abcdefghijklmn',
  'a=end-of-candidates',
  'a=sctp-port:5000',
  '',
].join('\r\n');

describe('privateAddress', () => {
  it.each([
    '10.0.0.130',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.20',
    '169.254.136.94',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    'fd7a:115c:a1e0::3b38:136',
    'fe80::dc:93da:66a9:4cc4%en0',
    'febf::1',
    '::1',
    '::ffff:10.1.2.3',
  ])('accepts %s', (address) => {
    expect(privateAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '172.15.0.1',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '192.169.0.1',
    '169.253.0.1',
    '2001:db8:85a3::8a2e:370:7334',
    '2607:f8b0:4004:c07::8a',
    'fec0::1',
    '::ffff:8.8.8.8',
    '::',
    '203.0.113.9',
    'example.com',
    '',
  ])('refuses %s', (address) => {
    expect(privateAddress(address)).toBe(false);
  });
});

describe('filterCandidates', () => {
  it("keeps a viewer's host candidates, including its mDNS name, and drops its public ones", () => {
    const { sdp, kept } = filterCandidates(CHROME_OFFER);
    expect(kept).toBe(2);
    const lines = sdp.split('\r\n');
    expect(lines.filter((line) => line.startsWith('a=candidate:')).map((line) => line.split(' ')[4])).toEqual([
      '7c6f1a2e-5b0d-4e0a-9f55-1d3c0b6a2e11.local',
      '192.168.1.20',
    ]);
    expect(sdp).not.toContain('203.0.113.9 54321 typ srflx');
    expect(sdp).not.toContain('2001:db8');
    expect(sdp).not.toContain('attacker.example.com');
    expect(lines).toContain('c=IN IP4 0.0.0.0');
    expect(lines).toContain('a=end-of-candidates');
    expect(sdp.endsWith('\r\n')).toBe(true);
  });

  it("leaves the sender's answer with only its private, link-local and tailnet candidates", () => {
    const answer = [
      'v=0',
      'o=rtc 123 0 IN IP4 127.0.0.1',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'c=IN IP4 10.0.0.130',
      'a=candidate:1 1 UDP 2114977791 10.0.0.130 58746 typ host',
      'a=candidate:2 1 UDP 2114977535 100.71.1.54 58746 typ host',
      'a=candidate:3 1 UDP 2116025855 fd7a:115c:a1e0::3b38:136 58746 typ host',
      'a=candidate:4 1 UDP 2116025855 2603:6011:1a00:1234::5 58746 typ host',
      'a=candidate:5 1 UDP 1686110207 70.83.20.250 58746 typ srflx raddr 10.0.0.130 rport 58746',
      '',
    ].join('\r\n');
    const { sdp, kept } = filterCandidates(answer);
    expect(kept).toBe(3);
    expect(sdp).not.toContain('2603:6011');
    expect(sdp).not.toContain('70.83.20.250');
    expect(sdp).toContain('c=IN IP4 10.0.0.130');
  });

  it('reports no candidates when none is local, so the caller can refuse', () => {
    const offer = ['v=0', 'a=candidate:1 1 udp 1 198.51.100.7 5000 typ srflx raddr 0.0.0.0 rport 0', ''].join('\r\n');
    expect(filterCandidates(offer).kept).toBe(0);
  });
});
