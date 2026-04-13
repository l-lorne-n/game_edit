import { NextRequest, NextResponse } from 'next/server';

import { createProjectService } from '@/lib/projects/service';

const projectService = createProjectService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const project = await projectService.getProject(id);
    if (!project) {
      return NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 });
    }

    const versionParam = request.nextUrl.searchParams.get('version');
    const version = versionParam ? Number.parseInt(versionParam, 10) : project.currentVersion;

    if (Number.isNaN(version) || version < 1) {
      return NextResponse.json({ ok: false, error: 'Invalid version' }, { status: 400 });
    }

    const result = await projectService.listProjectFiles(id, version);
    return NextResponse.json({ ok: true, version, ...result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to list project files' },
      { status: 500 },
    );
  }
}
