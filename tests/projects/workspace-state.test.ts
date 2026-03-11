import { describe, expect, it } from 'vitest';

import { createTemplatePackage } from '@/lib/package/template';
import {
  addProject,
  archiveCurrentPackage,
  buildSnapshotDisplay,
  createDefaultWorkspace,
  deleteProject,
  removeSnapshotSubtree,
} from '@/lib/workspace/state';

describe('workspace state', () => {
  it('creates and deletes projects while keeping workspace active', () => {
    const workspace = createDefaultWorkspace('Project 1');
    const added = addProject(workspace, 'Project 2');
    expect(added.ok).toBe(true);
    if (!added.ok) {
      return;
    }

    const deleted = deleteProject(added.workspace, added.project.id);
    expect(deleted.projects.length).toBe(1);
    expect(deleted.activeProjectId).toBe(deleted.projects[0].id);
  });

  it('archives snapshots and removes subtree branches', () => {
    const workspace = createDefaultWorkspace('Branching');
    const baseProject = {
      ...workspace.projects[0],
      currentPackage: createTemplatePackage('Base'),
    };

    const root = archiveCurrentPackage(baseProject, { parentSnapshotId: null });
    expect(root.ok).toBe(true);
    if (!root.ok) {
      return;
    }

    const withChildPkg = {
      ...root.project,
      currentPackage: createTemplatePackage('Child'),
    };
    const child = archiveCurrentPackage(withChildPkg, { parentSnapshotId: root.snapshot.id });
    expect(child.ok).toBe(true);
    if (!child.ok) {
      return;
    }

    const display = buildSnapshotDisplay(child.project.snapshots);
    expect(display[0].snapshot.id).toBe(root.snapshot.id);
    expect(display[1].snapshot.id).toBe(child.snapshot.id);

    const removed = removeSnapshotSubtree(child.project, root.snapshot.id);
    expect(removed.snapshots).toHaveLength(0);
  });
});
