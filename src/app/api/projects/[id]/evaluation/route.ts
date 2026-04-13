import { NextResponse } from 'next/server';

import type { EvaluatorResult } from '@/lib/evaluator/types';
import { createProjectService } from '@/lib/projects/service';

const projectService = createProjectService();

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as { version?: number; evaluator?: EvaluatorResult | null };

    if (typeof body.version !== 'number' || body.version < 1) {
      return NextResponse.json({ ok: false, error: 'Invalid version' }, { status: 400 });
    }

    const project = await projectService.updateVersionEvaluation(id, body.version, body.evaluator ?? null);
    return NextResponse.json({ ok: true, project });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to update evaluation' },
      { status: 500 },
    );
  }
}
