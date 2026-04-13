import { NextRequest, NextResponse } from 'next/server';

import { isCanonicalPackageFilePath } from '@/lib/projects/package-files';
import { createProjectService } from '@/lib/projects/service';

const projectService = createProjectService();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const filePath = request.nextUrl.searchParams.get('path');
    const version = Number.parseInt(request.nextUrl.searchParams.get('version') ?? '', 10);

    if (!filePath || !isCanonicalPackageFilePath(filePath)) {
      return NextResponse.json({ ok: false, error: 'Missing or invalid path parameter' }, { status: 400 });
    }

    const project = await projectService.getProject(id);
    if (!project) {
      return NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 });
    }

    const targetVersion = Number.isNaN(version) ? project.currentVersion : version;
    const content = await projectService.readProjectFile(id, targetVersion, filePath);
    if (content === null) {
      return NextResponse.json({ ok: false, error: 'File not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, path: filePath, version: targetVersion, content });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to read project file' },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as { path?: string; content?: string };

    if (!body.path || typeof body.content !== 'string' || !isCanonicalPackageFilePath(body.path)) {
      return NextResponse.json({ ok: false, error: 'Missing or invalid path/content' }, { status: 400 });
    }

    const project = await projectService.writeSingleFile(id, body.path, body.content);
    return NextResponse.json({ ok: true, project });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to write project file' },
      { status: 500 },
    );
  }
}
