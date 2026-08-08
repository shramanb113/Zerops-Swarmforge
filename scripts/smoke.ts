const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? 'http://localhost:3000';

async function main(): Promise<void> {
  const createResponse = await fetch(`${CONTROL_PLANE_URL}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'smoke-test', role: 'architect', payload: { note: 'foundation smoke test' } }),
  });

  if (createResponse.status !== 201) {
    throw new Error(`expected 201 from POST /tasks, got ${createResponse.status}`);
  }

  const { id } = (await createResponse.json()) as { id: string };
  console.log(`created task ${id}, polling /world-state for completion...`);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const stateResponse = await fetch(`${CONTROL_PLANE_URL}/world-state`);
    const state = (await stateResponse.json()) as { tasks: Array<{ id: string; status: string }> };
    const task = state.tasks.find((t) => t.id === id);
    if (task?.status === 'done') {
      console.log('task completed successfully');
      const presenceResponse = await fetch(`${CONTROL_PLANE_URL}/presence`);
      const presence = (await presenceResponse.json()) as { agents: Array<{ role: string }> };
      if (!presence.agents.some((a) => a.role === 'architect')) {
        throw new Error('expected an architect agent to be present');
      }
      console.log('presence check passed: architect is online');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`task ${id} did not reach status "done" within 15s`);
}

main()
  .then(() => {
    console.log('SMOKE TEST PASSED');
    process.exit(0);
  })
  .catch((err) => {
    console.error('SMOKE TEST FAILED:', err);
    process.exit(1);
  });
