// Manual integration check: uploads synthetic media and asks Higgsfield for a quote.
// It does not submit a generation job or print credentials.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;
const { invoke } = require('../higgsfieldCli');

(async () => {
  const profile = os.homedir();
  const creds = JSON.parse(await fs.readFile(path.join(profile, '.higgsfield', 'credentials.json'), 'utf8'));
  const session = { higgsfield: { connected: true, token: creds.access_token,
    refreshToken: creds.refresh_token, workspaceId: creds.workspace_id } };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'character-cli-test-'));
  try {
    const image = path.join(dir, 'reference.png');
    const video = path.join(dir, 'clip.mp4');
    for (const args of [
      ['-f', 'lavfi', '-i', 'color=c=red:s=512x512', '-frames:v', '1', '-update', '1', '-y', image],
      ['-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=24', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video]
    ]) {
      const result = spawnSync(ffmpeg, ['-loglevel', 'error', ...args], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
    }
    const quote = await invoke(['generate', 'cost', 'hf_mult_motion_control', '--resolution', '720p'], session, [
      { flag: '--image-references', filename: 'reference.png', write: dest => fs.copyFile(image, dest) },
      { flag: '--video-references', filename: 'clip.mp4', write: dest => fs.copyFile(video, dest) }
    ]);
    if (!Number.isFinite(quote.credits) || quote.credits <= 0) throw new Error('Cotação inválida.');
    console.log(`Genjutsu OAuth upload + quote OK: ${quote.credits} créditos.`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
