// LoLLM — guard "packaging": Dockerfile, .dockerignore, workflow image, dan konsistensi versi.
// Sengaja tanpa `docker` (tidak tersedia di CI node / sandbox): yang diperiksa adalah
// kontrak statis yang biasa bikin image gagal jalan — file yang di-COPY tidak ada,
// .dockerignore memakan public/, healthcheck menunjuk path terkunci, atau versi tidak sinkron.
// Jalankan: npm test

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const dockerfile = read('Dockerfile');
const dockerignore = read('.dockerignore');
const pkg = JSON.parse(read('package.json'));
const webPkg = JSON.parse(read('web/package.json'));
const workflow = read('.github/workflows/docker.yml');

/** Baris Dockerfile → array instruksi (baris lanjutan digabung, komentar utuh-baris dibuang). */
function instructions(text) {
  const out = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*#.*$/, '').trim();
    const cont = line.endsWith('\\');
    const body = cont ? line.slice(0, -1).trim() : line;
    if (cur) cur.value += ' ' + body;
    else {
      const sp = body.search(/\s/);
      cur = sp < 0 ? { instr: body.toUpperCase(), value: '' } : { instr: body.slice(0, sp).toUpperCase(), value: body.slice(sp + 1).trim() };
    }
    if (!cont) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

const ins = instructions(dockerfile);
const of = (name) => ins.filter((i) => i.instr === name);

/` KEY="value" KEY2=value2 `*/
function envLike(instrs) {
  const out = {};
  for (const i of instrs) {
    for (const m of i.value.matchAll(/([A-Za-z_][\w.]*)=("([^"]*)"|'([^']*)'|([^\s]+))/g)) {
      out[m[1]] = m[3] ?? m[4] ?? m[5] ?? '';
    }
  }
  return out;
}

describe('#Docker image siap build', () => {
  test('semua sumber yang di-COPY ada di repo (build tidak gagal di tengah)', () => {
    const copies = of('COPY');
    assert.ok(copies.length >= 4, 'Dockerfile seharusnya COPY package.json, bin, src, public');
    for (const c of copies) {
      const tokens = c.value.replace(/--chown=\S+/g, '').trim().split(/\s+/);
      const srcs = tokens.slice(0, -1); // token terakhir = dest
      for (const s of srcs) {
        assert.ok(fs.existsSync(path.join(root, s)), `COPY ${s} — path tidak ada di repo`);
      }
    }
  });

  test('.dockerignore tidak memakan apa pun yang dibutuhkan image', () => {
    const patterns = dockerignore.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('!'));
    const negated = new Set(dockerignore.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('!')).map((l) => l.slice(1)));
    const needed = new Set();
    for (const c of of('COPY')) {
      for (const s of c.value.replace(/--chown=\S+/g, '').trim().split(/\s+/).slice(0, -1)) {
        needed.add(s.replace(/^\.\//, '').split('/')[0]); // top-level saja: yang bisa kena ignore
      }
    }
    for (const n of needed) {
      const hit = patterns.find((p) => !p.startsWith('!') && (p === n || p === `${n}/*` || p === `${n}/**`));
      assert.ok(!hit || negated.has(n), `public/ dibutuhkan image tapi .dockerignore mengecualikan lewat "${hit}"`);
    }
    assert.ok(needed.has('public'), 'image harus menyertakan public/ (dashboard di-commit)');
  });

  test('context build kecil: web/ & node_modules dikecualikan', () => {
    for (const p of ['node_modules', 'web/node_modules', 'web/src']) {
      assert.ok(dockerignore.split('\n').some((l) => l.trim() === p), `${p} harus ada di .dockerignore`);
    }
    assert.ok(!/\n\s*web\s*\n/.test(`\n${dockerignore}\n`), 'web/ utuh tidak boleh di-ignore (public/ dibangun dari repo, bukan web/)');
  });

  test('runtime: non-root, PORT/EXPOSE selaras, CMD menjalankan CLI', () => {
    const user = of('USER').at(-1)?.value;
    assert.equal(user, 'node', 'harus jalan sebagai user non-root');
    const env = envLike(of('ENV'));
    assert.equal(env.NODE_ENV, 'production');
    assert.equal(env.HOST, '0.0.0.0', 'container harus bind 0.0.0.0 supaya port terpetakan');
    const exposed = of('EXPOSE').map((i) => i.value.trim());
    assert.deepEqual(exposed, [env.PORT], `EXPOSE ${exposed} harus sama dengan ENV PORT=${env.PORT}`);
    assert.equal(env.LOLLM_HOME, '/app/data', 'data harus di luar kode, cocok dengan VOLUME');
    assert.ok(of('VOLUME').some((i) => i.value.includes('/app/data')), 'perlu VOLUME agar config tidak hilang saat upgrade');
    const cmd = of('CMD')[0]?.value;
    assert.match(cmd, /bin\/lollm\.js/, 'CMD harus menjalankan bin/lollm.js');
    assert.equal(of('STOPSIGNAL')[0]?.value, 'SIGTERM', 'SIGTERM → shutdown bersih');
  });

  test('HEALTHCHECK menunjuk endpoint publik yang benar-benar ada', () => {
    const hc = of('HEALTHCHECK')[0]?.value || '';
    assert.match(hc, /--interval=\d+s/, 'interval wajib supaya swarm/k8s tidak menebak');
    assert.match(hc, /--start-period=\d+s/, 'start-period wajib: container baru sempat boot sebelum dihitung gagal');
    const m = hc.match(/https?:\/\/[^\s"']+/);
    assert.ok(m, 'HEALTHCHECK harus punya URL');
    const p = m[0].replace(/^[^:]+:\/\/[^/]+/, '').replace(/["']/g, '');
    assert.ok(['/healthz', '/health', '/live'].includes(p), `healthcheck harus endpoint publik (dapat ${p})`);
    const server = read('src/server.js');
    assert.ok(server.includes(`'${p}'`), `${p} tidak dikenal server`);
    assert.ok(!/\/api\//.test(p) && !/readyz/.test(p), 'jangan pakai /api (butuh sesi) atau /readyz (gagal bila provider belum ada)');
    assert.match(hc, /\$\{PORT/, 'healthcheck harus menghormati override PORT');
  });

  test('label OCI versi diisi lewat build-arg supaya bisa di-inspect', () => {
    assert.match(dockerfile, /^ARG VERSION=/m, 'perlu ARG VERSION (dipakai CI & build lokal)');
    assert.match(dockerfile, /^ARG REVISION=/m, 'perlu ARG REVISION untuk menautkan image ke commit');
    assert.match(dockerfile, /org\.opencontainers\.image\.version="?\$\{VERSION\}"?/);
    assert.match(dockerfile, /org\.opencontainers\.image\.revision="?\$\{REVISION\}"?/);
    const labels = envLike(of('LABEL'));
    for (const k of ['org.opencontainers.image.title', 'org.opencontainers.image.source', 'org.opencontainers.image.licenses', 'org.opencontainers.image.description']) {
      assert.ok(labels[k], `label ${k} wajib ada (dipakai halaman GHCR & docker inspect)`);
    }
    assert.match(labels['org.opencontainers.image.source'], /^https:\/\/github\.com\/[^/]+\/[^/]+$/);
    // anchor README rawan berubah — dokumentasi cukup ke file-nya
    assert.ok(!/#/.test(labels['org.opencontainers.image.documentation'] || ''), 'documentation URL jangan pakai anchor');
    assert.match(dockerfile, /org\.opencontainers\.image\.source="https:\/\/github\.com\/NetBypass\/LoLLM"/);
  });

  test('workflow image: smoke dulu, baru publish; tag latest & semver', () => {
    const on = workflow.match(/^on:$/m) ? workflow.slice(workflow.indexOf('on:')) : '';
    assert.match(on.slice(0, 400), /branches: \[main\]/, 'build di main');
    assert.match(on.slice(0, 400), /tags: \['v\*'\]/, 'push tag v* menghasilkan image berversi');
    assert.match(workflow, /pull_request:/, 'PR juga harus membangun image (tanpa push)');
    assert.match(workflow, /needs: smoke/, 'publish harus menunggu smoke test container');
    assert.match(workflow, /if: github\.event_name != 'pull_request'/, 'PR tidak boleh mem-push image');
    assert.match(workflow, /value=latest,enable=\{\{is_default_branch\}\}/, 'latest hanya dari branch default');
    assert.match(workflow, /type=semver,pattern=\{\{version\}\}/, 'tag v0.2.0 → image 0.2.0');
    assert.match(workflow, /platforms: linux\/amd64,linux\/arm64/, 'multi-arch (pi/Apple Silicon juga menarik image ini)');
    assert.match(workflow, /packages: write/, 'permission GHCR');
    assert.match(workflow, /provenance: mode=max/, 'provenance + sbom untuk supply chain');
    for (const step of ['/healthz', '/readyz', 'bin/lollm.js key', 'messages cannot be empty']) {
      assert.ok(workflow.includes(step), `smoke test harus memeriksa: ${step}`);
    }
  });

  test('smoke test menguji kontrak "200 harus berisi" di container', () => {
    const m = workflow.match(/Cek kontrak respons[\s\S]*?Log container/);
    assert.ok(m, 'step kontrak respons hilang');
    const body = m[0];
    assert.match(body, /200 tanpa content/i, 'harus menolak 200 dengan content kosong');
    assert.match(body, /x_lollm/, 'harus menuntut field transparansi di body');
    assert.match(body, /x-lollm-provider:/, 'harus menuntut header transparansi');
    assert.match(body, /404, 502, 503, 429/, 'failure harus status sah + beralasan, bukan 200 hampa');
  });
});

describe('#Versi konsisten', () => {
  test('package.json, web/package.json, src/version.js sama', () => {
    assert.equal(pkg.version, VERSION, 'package.json ≠ src/version.js');
    assert.equal(webPkg.version, VERSION, 'web/package.json ≠ src/version.js');
    assert.match(VERSION, /^\d+\.\d+\.\d+$/, 'format semver');
  });

  test('CLI melaporkan versi yang sama, dan README tidak menyebut versi basi', () => {
    const out = execFileSync(process.execPath, [path.join(root, 'bin/lollm.js'), '--version'], { encoding: 'utf8' });
    assert.equal(out.trim(), `lollm ${VERSION}`);
    const readme = read('README.md');
    for (const m of readme.matchAll(/lollm[:@]v?(\d+\.\d+\.\d+)/g)) {
      assert.equal(m[1], VERSION, `README menyebut v${m[1]} padahal ${VERSION}`);
    }
  });

  test('Dockerfile memakai base image bertanda besar (bukan :latest)', () => {
    const from = of('FROM')[0].value;
    assert.match(from, /^node:\d+-alpine$/, `base image harus dipin: ${from}`);
    const major = Number(from.match(/node:(\d+)/)[1]);
    assert.ok(major >= 18, `node ${major} < 18 — gateway mensyaratkan >= 18 (lihat package.json engines)`);
  });
});
