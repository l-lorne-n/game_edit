import { NextResponse } from 'next/server';

import { createProjectService } from '@/lib/projects/service';

const projectService = createProjectService();

export async function GET() {
  try {
    const projects = await projectService.listProjects();
    return NextResponse.json({ ok: true, projects });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to list projects' },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { name?: string };
    const name = body.name?.trim() || 'New Game Project';
    const project = await projectService.createProject({ name });
    return NextResponse.json({ ok: true, project }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to create project' },
      { status: 500 },
    );
  }
}
