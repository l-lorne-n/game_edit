import { NextResponse } from 'next/server';

import { readLocalStoredFile } from '@/lib/storage/providers/local';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const logicalPath = path.join('/');
  const file = await readLocalStoredFile(logicalPath);

  if (!file) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(file.body), {
    status: 200,
    headers: {
      'Content-Type': file.contentType,
      'Cache-Control': 'no-store',
    },
  });
}
