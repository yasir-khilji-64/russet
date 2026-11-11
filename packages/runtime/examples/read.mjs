// oxlint-disable no-console
import { parseExampleOptions, runLiveExample } from './shared.mjs';

const options = parseExampleOptions(process.argv.slice(2));

const message = [
  'Inspect the current workspace using the available filesystem tools.',
  'Identify its main structure and read one relevant project file.',
  'Use the information you actually observe to produce a concise summary.',
  'Do not modify any files.',
].join(' ');

runLiveExample({
  options,
  message,
  requiredSuccessfulTools: ['fs_list', 'fs_read'],
}).catch((error) => {
  console.error(
    '\n[Read example failed]',
    error instanceof Error ? error.message : String(error),
  );

  process.exitCode = 1;
});
