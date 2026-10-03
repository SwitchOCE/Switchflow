// Gives a test process a private Git home. Not a test file: importing it registers no tests.
// The host Git bridge reads the global Git config and refuses signing or helper policies there,
// so a machine-wide setting (Claude cloud signs every commit) would decide these tests' results.
// Import it before any Switchflow module, so cache locations derived from the home stay put.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') process.env.XDG_CACHE_HOME ||= path.join(os.homedir(), '.cache');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'switchflow-git-home-'));
fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Switchflow Test\n\temail = test@example.invalid\n');
// Git reads HOME on every platform, then XDG_CONFIG_HOME/git/config.
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = home;
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
