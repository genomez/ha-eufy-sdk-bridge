import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { temporary, until } from "./helpers/recordings-fixtures.mjs";
import { createPlaybackExperiments, validateExperiments } from "../src/recordings-experiments.mjs";
import { createDownloadSpool, DOWNLOAD_BYTES, downloadEvidence } from "../src/recordings-download.mjs";
import { createClipJobs } from "../src/recordings-clips.mjs";

for (const [codec, nal] of [
  ["h264", [0x67, 0x64]],
  ["hevc", [0x40, 1]],
])
  test(`demuxes fragmented XZYH ${codec} into a private elementary stream`, async (t) => {
    const root = await temporary(t),
      spool = createDownloadSpool(root);
    const data = Buffer.from([0, 0, 0, 1, ...nal, 9]);
    const raw = Buffer.alloc(38 + data.length);
    raw.write("XZYH");
    raw.writeUInt16LE(1300, 4);
    raw.writeUInt32LE(raw.length - 16, 6);
    raw.writeUInt32LE(data.length, 16);
    raw[21] = codec === "hevc" ? 1 : 0;
    data.copy(raw, 38);
    spool.write(raw.subarray(0, 9));
    spool.write(raw.subarray(9));
    spool.close({ captureOutcome: "eof" });
    assert.deepEqual(fs.readFileSync(spool.file.replace(/\.bin$/, `.${codec}`)), data);
    const receipt = JSON.parse(fs.readFileSync(spool.file.replace(/\.bin$/, ".json")));
    assert.equal(receipt.outcome, "eof");
    assert.equal(receipt.demux.parsedFrameCount, 1);
    assert.equal(receipt.demux.codec, codec);
  });

test("download mode requires valid arming and consumes its durable budget once", async (t) => {
  const root = await temporary(t),
    file = path.join(root, "experiments.json");
  assert.equal(validateExperiments({ mode: "other" }), null);
  assert.equal(validateExperiments({ mode: null }), null);
  assert.equal(validateExperiments({ mode: "playback" }).mode, "playback");
  assert.equal(validateExperiments({}).mode, undefined);
  assert.equal(createPlaybackExperiments(root).take(), undefined);
  fs.writeFileSync(file, '{"mode":"download","maxClips":1}');
  assert.equal(createPlaybackExperiments(root).take().mode, "download");
  assert.equal(createPlaybackExperiments(root).take(), undefined);
  assert.equal(fs.existsSync(file), true);
});

test("spool caps writes, preserves artifacts and uses private permissions", async (t) => {
  const root = await temporary(t),
    spool = createDownloadSpool(root);
  assert.equal(spool.write(Buffer.alloc(DOWNLOAD_BYTES - 2)), DOWNLOAD_BYTES - 2);
  assert.equal(spool.write(Buffer.alloc(100)), 2);
  assert.equal(spool.write(Buffer.alloc(10)), 0);
  spool.close({
    captureOutcome: "capped",
    reconnectOutcome: "connected",
    download: { fileBytes: DOWNLOAD_BYTES, firstBytes: "other" },
  });
  spool.close({});
  assert.equal(fs.statSync(spool.file).size, DOWNLOAD_BYTES);
  const receipt = JSON.parse(fs.readFileSync(spool.file.replace(/\.bin$/, ".json")));
  assert.equal(receipt.mode, "download");
  assert.equal(receipt.outcome, "capped");
  assert.equal(receipt.spoolBytes, DOWNLOAD_BYTES);
  assert.throws(() => spool.write(Buffer.alloc(1)));
  if (process.platform !== "win32") {
    for (const name of fs.readdirSync(path.join(root, "experiments")))
      assert.equal(fs.statSync(path.join(root, "experiments", name)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(root, "experiments")).mode & 0o777, 0o700);
  }
});

test("linked spool directory refuses evidence writes", { skip: process.platform === "win32" }, async (t) => {
  const root = await temporary(t),
    elsewhere = await temporary(t);
  fs.symlinkSync(elsewhere, path.join(root, "experiments"));
  assert.throws(() => createDownloadSpool(root));
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test("evidence projection drops identifiers, prefixes and unbounded or malformed fields", () => {
  const value = downloadEvidence({
    ackReceived: true,
    ackStatus: -7,
    firstBytes: "account-synthetic",
    prefix: "private-synthetic",
    fileBytes: DOWNLOAD_BYTES + 1,
    links: [
      { link: 2, count: 1, bytes: 10, firstByteMs: 1, lastByteMs: 2, serial: "private-synthetic" },
      { link: "private-synthetic" },
    ],
    routes: [{ link: 2, channel: null, command: null, count: 1, payload: "private-synthetic" }],
    terminalCommandIds: [1303, "private-synthetic"],
  });
  assert.equal(value.ackStatus, -7);
  assert.equal(value.firstBytes, "other");
  assert.equal(value.fileBytes, 0);
  assert.equal(value.links.length, 1);
  assert.equal(JSON.stringify(value).includes("synthetic"), false);
  assert.deepEqual(value.terminalCommandIds, [1303]);
});

for (const outcome of ["capped", "not_admitted", "preempted", "storage_failed", "malicious_ready"])
  test(`download ${outcome} remains evidence only, never converts or becomes ready`, async (t) => {
    const base = await temporary(t),
      root = path.join(base, "clips");
    fs.writeFileSync(path.join(base, "experiments.json"), '{"mode":"download"}');
    let pulls = 0;
    const jobs = createClipJobs({
      root,
      experiments: createPlaybackExperiments(base),
      enabled: () => true,
      live: () => false,
      changed: () => {},
      log: () => {},
      convert: () => assert.fail("download converted"),
      wait: () => assert.fail("download retried"),
      pull: async (_, opts) => {
        pulls++;
        assert.equal(opts.experiment.mode, "download");
        opts.beforeDispatch();
        opts.file(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]));
        const receipt = {
          mode: "download",
          experiment: opts.experiment,
          startAttempted: outcome !== "not_admitted",
          captureOutcome: outcome === "malicious_ready" ? "eof" : outcome,
          boundedMediaObserved: true,
          randomAccess: true,
          latchCleared: true,
          releaseOutcome: "release_confirmed",
          cessationOutcome: "ceased",
          reconnectOutcome: "connected",
          download: {
            ackReceived: true,
            ackStatus: 0,
            cancelAttempted: true,
            cancelSent: true,
            fileBytes: 8,
            firstBytes: "mp4_ftyp",
          },
        };
        if (outcome === "malicious_ready") {
          opts.mediaReady(receipt);
          assert.throws(() => opts.video(Buffer.from("synthetic-video")));
        }
        return receipt;
      },
    });
    jobs.load();
    t.after(() => jobs.stop());
    jobs.prepare("camera-synthetic", "event-synthetic", { selector: { expectedMs: 1000 } });
    await until(() => !jobs.busy() && jobs.status("camera-synthetic", "event-synthetic").clip.state === "failed");
    assert.equal(jobs.ready("camera-synthetic", "event-synthetic"), null);
    assert.equal(pulls, 1);
    assert.deepEqual(fs.readdirSync(root), []);
    const d = jobs.diagnostics().lastJob;
    assert.equal(d.mode, "download");
    assert.equal(d.experiment.mode, "download");
    assert.equal(d.download.ackStatus, 0);
    assert.equal(d.reason, outcome === "storage_failed" ? "storage" : "experiment_only");
    assert.equal(fs.readdirSync(path.join(base, "experiments")).length, 2);
    await jobs.stop();
    assert.equal(fs.readdirSync(path.join(base, "experiments")).length, 2);
  });

test("unarmed clips expose no FILE sink and no evidence directory", async (t) => {
  const base = await temporary(t),
    root = path.join(base, "clips");
  const jobs = createClipJobs({
    root,
    experiments: createPlaybackExperiments(base),
    enabled: () => true,
    live: () => false,
    changed: () => {},
    log: () => {},
    pull: async (_, opts) => {
      assert.equal(opts.file, undefined);
      assert.equal(opts.experiment, undefined);
      return { captureOutcome: "no_media", startAttempted: true };
    },
  });
  jobs.load();
  t.after(() => jobs.stop());
  jobs.prepare("camera-synthetic", "event-synthetic", { selector: { expectedMs: 1000 } });
  await until(() => jobs.status("camera-synthetic", "event-synthetic").clip.state === "failed");
  assert.equal(fs.existsSync(path.join(base, "experiments")), false);
});
