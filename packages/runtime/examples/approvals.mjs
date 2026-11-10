// oxlint-disable no-console
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { parseExampleOptions, runLiveExample } from './shared.mjs';

const options = parseExampleOptions(process.argv.slice(2), {
  allowWorkspace: false,
});

const TARGET_FILE = 'approval-demo.txt';

function createStdinApprovalBroker() {
  return {
    async request(approval, signal) {
      console.log('\n========== APPROVAL REQUEST ==========');
      console.log(`[Request ID] ${approval.id}`);
      console.log(`[Expires at] ${new Date(approval.expiresAt).toISOString()}`);
      console.log(`[Description] ${approval.description}`);

      const operation = approval.operation;

      // Do not approve an operation that cannot be inspected.
      if (operation === undefined) {
        console.log('[Denied] Complete operation details are unavailable.');
        return 'deny';
      }

      // This example only authorizes its intended creation target.
      console.log('\n[Exact operation]');
      console.log(JSON.stringify(operation, null, 2));

      const args = operation.arguments;

      const validOperation =
        operation.toolName === 'fs_create' &&
        operation.target === TARGET_FILE &&
        args !== null &&
        typeof args === 'object' &&
        !Array.isArray(args) &&
        args.path === TARGET_FILE &&
        typeof args.content === 'string';

      if (!validOperation) {
        console.log('[Denied] Operation does not match the example.');

        console.log('[Operation validation]', {
          toolName: operation.toolName,
          target: operation.target,
          argumentPath: args?.path,
          expectedTarget: TARGET_FILE,
        });

        return 'deny';
      }

      // Show the complete operation, including the proposed content.
      // Never approve based on a shortened or partial preview.
      console.log('\n[Exact operation]');
      console.log(JSON.stringify(operation, null, 2));

      const terminal = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        const answer = await terminal.question(
          '\nApprove this operation once? [y/N] ',
          { signal },
        );

        const approved = /^(y|yes)$/i.test(answer.trim());

        console.log(`[User decision] ${approved ? 'allow' : 'deny'}`);

        return approved ? 'allow' : 'deny';
      } catch {
        console.log('[User decision] deny');
        return 'deny';
      } finally {
        terminal.close();
      }
    },
  };
}

async function main() {
  if (!process.stdin.isTTY) {
    throw new Error(
      'This example requires an interactive terminal for stdin approval.',
    );
  }

  const sandbox = await mkdtemp(join(tmpdir(), 'russet-approval-e2e-'));

  const workspacePath = join(sandbox, 'workspace');
  const userConfigPath = join(sandbox, 'user.yaml');

  try {
    await mkdir(workspacePath, {
      recursive: true,
    });

    // The example exercises the actual workspace instruction loader.
    await writeFile(
      join(workspacePath, 'AGENTS.md'),
      [
        '# Runtime Approval Example',
        '',
        'This is a disposable demonstration workspace.',
        'Use only authorized Runtime operations.',
        'Do not modify AGENTS.md.',
        'If a tool operation is denied, report the denial.',
      ].join('\n'),
    );

    // User-level settings permit writes only after approval.
    await writeFile(
      userConfigPath,
      [
        'schema: 1',
        '',
        'defaults:',
        '  mode: workspace_write',
        '',
        'policy:',
        '  actions:',
        '    fs.read: allow',
        '    fs.search: allow',
        '    fs.write: ask',
        '    fs.delete: deny',
        '    process.execute: deny',
        '',
      ].join('\n'),
    );

    const message = [
      `Create a new file named "${TARGET_FILE}" in the workspace root.`,
      'Its contents should be a short statement explaining that',
      'Russet Runtime supports user-approved file creation.',
      'Use the managed filesystem tool to create the file.',
      'After the operation, explain whether it succeeded or was denied.',
      'If approval is denied, do not retry the operation.',
    ].join(' ');

    console.log('[Temporary workspace]', workspacePath);

    console.log('[Approval policy] fs.write requires explicit approval');

    await runLiveExample({
      options,
      message,

      workspacePath,
      userConfigPath,
      workspaceTrusted: false,

      enableWrites: true,
      approvalBroker: createStdinApprovalBroker(),

      requiredProposedTools: ['fs_create'],

      async verify({ stats }) {
        if (stats.approvalRequests === 0) {
          throw new Error('The approval broker was never invoked.');
        }

        const created = stats.outcomes.some(
          (entry) => entry.name === 'fs_create' && entry.status === 'success',
        );

        const targetPath = join(workspacePath, TARGET_FILE);

        let content;

        try {
          content = await readFile(targetPath, 'utf8');
        } catch (error) {
          if (
            error === null ||
            typeof error !== 'object' ||
            !('code' in error) ||
            error.code !== 'ENOENT'
          ) {
            throw error;
          }
        }

        if (created) {
          if (!stats.approvalDecisions.includes('allow') || !content?.trim()) {
            throw new Error(
              'Successful creation was not confirmed by approval and filesystem state.',
            );
          }

          console.log('\n[Verified] Approved file creation succeeded.');
          console.log(`[File] ${TARGET_FILE}`);
          console.log('[Content]');
          console.log(content);
        } else {
          if (content !== undefined) {
            throw new Error(
              'A file exists despite no confirmed successful creation.',
            );
          }

          console.log(
            '\n[Verified] No file was created without successful authorization.',
          );
        }
      },
    });
  } finally {
    await rm(sandbox, {
      recursive: true,
      force: true,
    });

    console.log('\n[Cleanup] Temporary workspace removed.');
  }
}

main().catch((error) => {
  console.error(
    '\n[Approval example failed]',
    error instanceof Error ? error.message : String(error),
  );

  process.exitCode = 1;
});
