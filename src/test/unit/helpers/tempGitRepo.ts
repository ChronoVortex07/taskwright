import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const DETERMINISTIC_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

export interface TempRepo {
  root: string;
  git(args: string[], env?: Record<string, string>): Promise<string>;
  writeFile(relPath: string, contents: string): void;
  addGitignore(lines: string[]): void;
  headSha(): Promise<string>;
  cleanup(): void;
}

/** Create a throwaway git repo in os.tmpdir() with one commit on `main`. */
export async function makeTempGitRepo(): Promise<TempRepo> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-boardref-'));
  const git = async (args: string[], env?: Record<string, string>): Promise<string> => {
    const res = await execFileAsync('git', args, {
      cwd: root,
      env: { ...process.env, ...DETERMINISTIC_ENV, ...env },
    });
    return res.stdout;
  };
  await git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(root, 'README.md'), '# temp\n');
  await git(['add', 'README.md']);
  await git(['commit', '-q', '-m', 'init']);
  return {
    root,
    git,
    writeFile(relPath, contents) {
      const abs = path.join(root, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, contents);
    },
    addGitignore(lines) {
      fs.writeFileSync(path.join(root, '.gitignore'), lines.join('\n') + '\n');
    },
    async headSha() {
      return (await git(['rev-parse', 'HEAD'])).trim();
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
