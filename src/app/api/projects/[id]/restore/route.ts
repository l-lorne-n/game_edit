import { NextResponse } from 'next/server';

import { createProjectService } from '@/lib/projects/service';

const projectService = createProjectService();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as { version?: number };

    if (typeof body.version !== 'number' || body.version < 1) {
      return NextResponse.json({ ok: false, error: 'Invalid version number' }, { status: 400 });
    }

    const project = await projectService.restoreVersion(id, body.version);
    return NextResponse.json({ ok: true, project, restoredFrom: body.version });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to restore project version';
    const status = /not found|previous version/i.test(message) ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
