import { NextResponse } from 'next/server';

import { getHealthSummary } from '@/lib/ai/config';
import { getInfraReadiness } from '@/lib/config/infra';
import { getSandboxReadiness } from '@/lib/sandbox';

export async function GET() {
  return NextResponse.json({
    ai: getHealthSummary(),
    infra: getInfraReadiness(),
    sandbox: getSandboxReadiness(),
  });
}
