import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockService = {
  listProjects: vi.fn(),
  createProject: vi.fn(),
  getProject: vi.fn(),
  saveGeneratedPackage: vi.fn(),
  restoreVersion: vi.fn(),
  updateVersionEvaluation: vi.fn(),
  writeSingleFile: vi.fn(),
  readProjectFile: vi.fn(),
  listProjectFiles: vi.fn(),
  deleteProject: vi.fn(),
};

vi.mock('@/lib/projects/service', () => ({
  createProjectService: () => mockService,
}));

describe('projects api routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists projects', async () => {
    mockService.listProjects.mockResolvedValue([{ id: 'p1', name: 'Project 1', currentVersion: 0, versions: [] }]);
    const { GET } = await import('@/app/api/projects/route');
    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.projects).toHaveLength(1);
  });

  it('creates a project', async () => {
    mockService.createProject.mockResolvedValue({ id: 'p2', name: 'Project 2', currentVersion: 0, versions: [] });
    const { POST } = await import('@/app/api/projects/route');
    const response = await POST(new Request('http://localhost/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Project 2' }) }));
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.project.id).toBe('p2');
  });

  it('restores a previous version through the restore route', async () => {
    mockService.restoreVersion.mockResolvedValue({ id: 'p1', currentVersion: 3, versions: [{ version: 3, restoredFromVersion: 1 }] });
    const { POST } = await import('@/app/api/projects/[id]/restore/route');
    const response = await POST(
      new Request('http://localhost/api/projects/p1/restore', {
        method: 'POST',
        body: JSON.stringify({ version: 1 }),
      }),
      { params: Promise.resolve({ id: 'p1' }) },
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.restoredFrom).toBe(1);
    expect(mockService.restoreVersion).toHaveBeenCalledWith('p1', 1);
  });

  it('updates a version evaluation through the evaluation route', async () => {
    mockService.updateVersionEvaluation = vi.fn().mockResolvedValue({ id: 'p1', currentVersion: 2, versions: [{ version: 2, status: 'failed' }] });
    const { PUT } = await import('@/app/api/projects/[id]/evaluation/route');
    const response = await PUT(
      new Request('http://localhost/api/projects/p1/evaluation', {
        method: 'PUT',
        body: JSON.stringify({ version: 2, evaluator: { ok: false, code: 'RUNTIME_ERROR', source: 'sandbox', summary: 'boom', at: new Date().toISOString(), errors: [], logs: [] } }),
      }),
      { params: Promise.resolve({ id: 'p1' }) },
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(mockService.updateVersionEvaluation).toHaveBeenCalled();
  });
});
