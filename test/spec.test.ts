// Checks that the spec files agree with each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const readJSON = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const wire = readJSON('wire.json');
const ring = wire.ring;
const field = (name: string) => {
	const f = ring.fields.find((x: { name: string }) => x.name === name);
	assert.ok(f, `wire.json has no ring field ${name}`);
	return f as { name: string; offset: number; size: number };
};

test('ring fields fit the control block and do not overlap', () => {
	const sorted = [...ring.fields].sort((a, b) => a.offset - b.offset);
	let end = 0;
	for (const f of sorted) {
		assert.ok(f.offset >= end, `${f.name} overlaps the field before it`);
		assert.equal(f.offset % f.size, 0, `${f.name} is not aligned to its size`);
		end = f.offset + f.size;
	}
	assert.ok(end <= ring.header_size, 'fields run past header_size');
	assert.equal(ring.header_size, 4 * ring.cache_line);
	for (const n of ['tail', 'head', 'head_cache']) {
		assert.equal(field(n).offset % ring.cache_line, 0, `${n} must start a cache line`);
	}
});

const manifest = readJSON('vectors/ring/manifest.json');
const ringDir = join(root, 'vectors/ring');

test('every ring case has an image and every image has a case', () => {
	const cases = new Set<string>(manifest.cases.map((c: { name: string }) => c.name));
	const images = new Set(readdirSync(ringDir).filter((f) => f.endsWith('.bin')).map((f) => f.slice(0, -4)));
	assert.deepEqual([...images].sort(), [...cases].sort());
});

for (const c of manifest.cases) {
	test(`ring image ${c.name} matches its manifest entry`, () => {
		const img = readFileSync(join(ringDir, `${c.name}.bin`));
		assert.equal(img.length, c.buffer_size);
		const u64 = (name: string) => img.readBigUInt64LE(field(name).offset);
		assert.equal(u64('magic'), BigInt(ring.magic));
		assert.equal(img.readUInt32LE(field('version').offset), ring.version);
		const capacity = u64('capacity');
		assert.equal(capacity & (capacity - 1n), 0n, 'capacity is not a power of two');
		assert.ok(capacity >= BigInt(ring.min_capacity));
		assert.ok(BigInt(ring.header_size) + capacity <= BigInt(c.buffer_size));
		assert.equal(u64('head'), BigInt(c.head));
		assert.equal(u64('tail'), BigInt(c.tail));
		assert.ok(u64('tail') - u64('head') <= capacity, 'more bytes in flight than capacity');
	});
}
