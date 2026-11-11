import type { WorkspaceFileAction, WorkspaceResourceKind } from './types.js';

export function protectedResourceRule(
  action: WorkspaceFileAction,
  path: string,
  kind: WorkspaceResourceKind,
): string | undefined {
  const parts = path.toLowerCase().split('/');
  const normalized = parts.join('/');
  const name = parts.at(-1) ?? '';

  const isMutation = action === 'fs.write' || action === 'fs.delete';

  if (normalized === '.' && isMutation) {
    return 'workspace.root';
  }

  if (action === 'fs.delete' && kind === 'directory') {
    return 'workspace.directory_delete';
  }

  if (parts.includes('.git')) {
    return 'protected.git';
  }

  if (
    parts.some((part) => part === '.env' || part.startsWith('.env.')) ||
    name.endsWith('.pem') ||
    name.endsWith('.key')
  ) {
    return 'protected.secret';
  }

  if (isMutation) {
    if (['.gitignore', '.gitattributes', '.gitmodules'].includes(name)) {
      return 'protected.git_metadata';
    }

    if (
      normalized === '.russet' ||
      normalized === '.russet/project.yaml' ||
      normalized === '.russet/extensions' ||
      normalized.startsWith('.russet/extensions/')
    ) {
      return 'protected.runtime_configuration';
    }
  }

  return undefined;
}
