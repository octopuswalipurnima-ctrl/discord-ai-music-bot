import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress } from '../dist/network-guard.js';

test('blocks loopback, private, link-local, CGNAT and reserved IPv4 ranges', () => {
  for (const ip of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '100.64.0.1', '100.127.255.255', '198.18.0.1', '203.0.113.9', '224.0.0.1', '255.255.255.255']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test('allows ordinary public IPv4 addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '93.184.216.34']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('blocks IPv6 loopback, unspecified, ULA, link-local and multicast', () => {
  for (const ip of ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1', '2001:db8::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test('blocks IPv4-mapped and NAT64 IPv6 forms of private IPv4 addresses (SSRF bypass forms)', () => {
  for (const ip of ['::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:192.168.1.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe',
    '0:0:0:0:0:ffff:c0a8:101', '64:ff9b::7f00:1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test('allows public IPv6 and public IPv4-mapped addresses', () => {
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('treats non-IP input as private', () => {
  assert.equal(isPrivateAddress('example.com'), true);
  assert.equal(isPrivateAddress(''), true);
});
