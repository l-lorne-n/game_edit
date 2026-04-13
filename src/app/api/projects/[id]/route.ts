import { NextResponse } from 'next/server';

import type { EvaluatorResult } from '@/lib/evaluator/types';
import { parseGeneratedGamePackage } from '@/lib/package/contracts';
import { createProjectService } from '@/lib/projects/service';
import type { ProjectSaveSource } from '@/lib/projects/types';

const projectService = createProjectService();

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const project = await projectService.getProject(id);
    if (!project) {
      return NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, project });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to load project' },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      pkg?: unknown;
      source?: ProjectSaveSource;
      parentVersion?: number | null;
      restoredFromVersion?: number | null;
      localSnapshotId?: string | null;
      evaluator?: EvaluatorResult | null;
    };

    const parsed = parseGeneratedGamePackage(body.pkg);
    if (!parsed.ok) {
      return NextResponse.json(
        { ok: false, error: 'pkg is required and must satisfy schema', validation: parsed },
        { status: 400 },
      );
    }

    const project = await projectService.saveGeneratedPackage({
      projectId: id,
      pkg: parsed.pkg,
      source: body.source ?? 'archive',
      parentVersion: typeof body.parentVersion === 'number' ? body.parentVersion : null,
      restoredFromVersion: typeof body.restoredFromVersion === 'number' ? body.restoredFromVersion : null,
      localSnapshotId: typeof body.localSnapshotId === 'string' ? body.localSnapshotId : null,
      evaluator: body.evaluator ?? null,
    });

    return NextResponse.json({ ok: true, project });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to persist project package' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await projectService.deleteProject(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to delete project' },
      { status: 500 },
    );
  }
}
