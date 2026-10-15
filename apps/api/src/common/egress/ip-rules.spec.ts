import {
  classifyIp,
  isAllowlistableCategory,
  isPublicCategory,
  type AddressCategory,
} from './ip-rules';

describe('classifyIp — IPv4', () => {
  const cases: Array<[string, AddressCategory]> = [
    // loopback (127.0.0.0/8)
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback'],
    ['127.255.255.255', 'loopback'],
    // unspecified / "this host" (0.0.0.0/8)
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    // private RFC1918
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.0.1', 'private'],
    ['192.168.255.255', 'private'],
    // just OUTSIDE the private ranges → public
    ['172.15.255.255', 'global'],
    ['172.32.0.1', 'global'],
    ['11.0.0.1', 'global'],
    ['192.169.0.1', 'global'],
    // link-local + IMDS (169.254.0.0/16)
    ['169.254.0.1', 'linkLocal'],
    ['169.254.255.255', 'linkLocal'],
    ['169.254.169.254', 'imds'],
    // CGNAT (100.64.0.0/10)
    ['100.64.0.1', 'cgnat'],
    ['100.127.255.255', 'cgnat'],
    ['100.63.255.255', 'global'],
    ['100.128.0.1', 'global'],
    // multicast / broadcast / reserved
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
    // documentation / special-use
    ['192.0.0.1', 'reserved'],
    ['192.0.2.5', 'reserved'],
    ['198.51.100.5', 'reserved'],
    ['203.0.113.5', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['192.88.99.1', 'reserved'],
    // public
    ['8.8.8.8', 'global'],
    ['1.1.1.1', 'global'],
    ['93.184.216.34', 'global'],
  ];

  it.each(cases)('classifies %s as %s', (addr, expected) => {
    expect(classifyIp(addr)).toBe(expected);
  });
});

describe('classifyIp — IPv4 reserved-range edges', () => {
  const cases: Array<[string, AddressCategory]> = [
    ['0.255.255.255', 'unspecified'],
    ['9.255.255.255', 'global'],
    ['126.255.255.255', 'global'],
    ['128.0.0.1', 'global'],
    ['169.253.255.255', 'global'],
    ['169.255.0.1', 'global'],
    ['192.167.255.255', 'global'],
    ['223.255.255.255', 'global'],
    ['240.0.0.0', 'reserved'],
    ['255.255.255.254', 'reserved'],
    ['192.0.0.255', 'reserved'],
    ['192.0.1.1', 'global'],
    ['192.0.2.0', 'reserved'],
    ['192.0.2.255', 'reserved'],
    ['192.0.3.1', 'global'],
    ['192.88.98.255', 'global'],
    ['192.88.99.255', 'reserved'],
    ['192.88.100.1', 'global'],
    ['198.17.255.255', 'global'],
    ['198.19.255.255', 'reserved'],
    ['198.20.0.1', 'global'],
    ['198.51.99.255', 'global'],
    ['198.51.100.255', 'reserved'],
    ['198.51.101.1', 'global'],
    ['203.0.112.255', 'global'],
    ['203.0.113.255', 'reserved'],
    ['203.0.114.1', 'global'],
  ];

  it.each(cases)('classifies %s as %s', (addr, expected) => {
    expect(classifyIp(addr)).toBe(expected);
  });
});

describe('classifyIp — IPv6 reserved-range edges', () => {
  const cases: Array<[string, AddressCategory]> = [
    // 100::/64 discard-only (AUD-065: was classed global)
    ['100::', 'reserved'],
    ['100::1', 'reserved'],
    ['100::ffff:ffff:ffff:ffff', 'reserved'],
    ['100:0:0:1::1', 'global'],
    ['100:1::1', 'global'],
    ['101::1', 'global'],
    // 2001:db8::/32 documentation
    ['2001:db8:ffff:ffff::1', 'reserved'],
    ['2001:db9::1', 'global'],
    ['2001:db7::1', 'global'],
    // ff00::/8 multicast
    ['ff00::', 'multicast'],
    ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'multicast'],
    // fe80::/10 link-local, fc00::/7 ULA
    ['febf:ffff::1', 'linkLocal'],
    ['fdff:ffff::1', 'uniqueLocal'],
    ['fbff::1', 'global'],
    // ::/128 and ::1/128
    ['::2', 'unspecified'],
    ['::0.0.0.1', 'loopback'],
    // IPv4-compatible ::/96 and NAT64 64:ff9b::/96 re-classify the embedded IPv4
    ['::10.0.0.1', 'private'],
    ['::169.254.169.254', 'imds'],
    ['64:ff9b::7f00:1', 'loopback'],
    ['64:ff9b::10.0.0.1', 'private'],
    ['64:ff9b::a9fe:a9fe', 'imds'],
    ['64:ff9b::808:808', 'global'],
    // IPv4-mapped carries every IPv4 category through
    ['::ffff:100.64.0.1', 'cgnat'],
    ['::ffff:224.0.0.1', 'multicast'],
    ['::ffff:255.255.255.255', 'broadcast'],
    ['::ffff:192.0.2.1', 'reserved'],
    ['::ffff:0.0.0.0', 'unspecified'],
  ];

  it.each(cases)('classifies %s as %s', (addr, expected) => {
    expect(classifyIp(addr)).toBe(expected);
  });
});

describe('classifyIp — IPv6', () => {
  const cases: Array<[string, AddressCategory]> = [
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'uniqueLocal'],
    ['fd12:3456:789a::1', 'uniqueLocal'],
    ['fe80::1', 'linkLocal'],
    ['fe80::abcd:1234', 'linkLocal'],
    ['fd00:ec2::254', 'imds'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'reserved'],
    ['2606:4700:4700::1111', 'global'],
    ['2001:4860:4860::8888', 'global'],
    // IPv4-mapped (::ffff:0:0/96) re-classifies the embedded IPv4
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:169.254.169.254', 'imds'],
    ['::ffff:8.8.8.8', 'global'],
    // IPv4-compatible (deprecated) likewise embeds IPv4
    ['::127.0.0.1', 'loopback'],
    // zone id is stripped before classification
    ['fe80::1%eth0', 'linkLocal'],
  ];

  it.each(cases)('classifies %s as %s', (addr, expected) => {
    expect(classifyIp(addr)).toBe(expected);
  });

  it('classifies the canonical-compressed IMDS-mapped form (::ffff:a9fe:a9fe) as imds', () => {
    // This is how the WHATWG URL parser renders ::ffff:169.254.169.254.
    expect(classifyIp('::ffff:a9fe:a9fe')).toBe('imds');
  });
});

describe('classifyIp — fail closed', () => {
  it.each([['not-an-ip'], ['999.1.1.1'], ['1.2.3'], ['1.2.3.4.5'], ['']])(
    'classifies the unparseable input %j as reserved (hard-denied)',
    (addr) => {
      expect(classifyIp(addr)).toBe('reserved');
    },
  );
});

describe('category policy buckets', () => {
  it('only private + uniqueLocal are allowlistable', () => {
    expect(isAllowlistableCategory('private')).toBe(true);
    expect(isAllowlistableCategory('uniqueLocal')).toBe(true);
    for (const c of [
      'loopback',
      'imds',
      'linkLocal',
      'unspecified',
      'cgnat',
      'multicast',
      'broadcast',
      'reserved',
      'global',
    ] as AddressCategory[]) {
      expect(isAllowlistableCategory(c)).toBe(false);
    }
  });

  it('only global is public', () => {
    expect(isPublicCategory('global')).toBe(true);
    expect(isPublicCategory('private')).toBe(false);
    expect(isPublicCategory('loopback')).toBe(false);
    expect(isPublicCategory('imds')).toBe(false);
  });
});
