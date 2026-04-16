import { NextResponse } from 'next/server';

import { AiSessionConflictError, createAiSessionService } from '@/lib/ai-sessions/service';
import { createProjectService } from '@/lib/projects/service';

const aiSessionService = createAiSessionService();
const projectService = createProjectService();

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      projectId?: string;
      ownerId?: string;
      baseVersion?: number;
    };

    if (!body.projectId) {
      return NextResponse.json({ ok: false, error: 'projectId is required' }, { status: 400 });
    }

    const project = await projectService.getProject(body.projectId);
    if (!project) {
      return NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 });
    }

    const session = await aiSessionService.createSession({
      projectId: body.projectId,
      ownerId: project.ownerId,
      baseVersion: typeof body.baseVersion === 'number' ? body.baseVersion : project.currentVersion,
    });

    return NextResponse.json({ ok: true, session }, { status: 201 });
  } catch (error) {
    if (error instanceof AiSessionConflictError) {
      return NextResponse.json({ ok: false, error: error.code }, { status: 409 });
    }
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to create AI session' },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const projectId = url.searchParams.get('projectId')?.trim();
    if (!projectId) {
      return NextResponse.json({ ok: false, error: 'projectId is required' }, { status: 400 });
    }

    const project = await projectService.getProject(projectId);
    if (!project) {
      return NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 });
    }

    const sessions = await aiSessionService.listProjectSessions(projectId);
    return NextResponse.json({ ok: true, sessions });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to list AI sessions' },
      { status: 500 },
    );
  }
}
