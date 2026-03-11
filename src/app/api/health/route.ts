import { NextResponse } from 'next/server';

import { getHealthSummary } from '@/lib/ai/config';

export async function GET() {
  return NextResponse.json(getHealthSummary());
}
