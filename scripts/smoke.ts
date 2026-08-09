const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? 'http://localhost:3000';

async function main(): Promise<void> {
  const createResponse = await fetch(`${CONTROL_PLANE_URL}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'build-product',
      role: 'architect',
      payload: { description: 'A simple REST API that returns a random inspirational quote.' },
    }),
  });

  if (createResponse.status !== 201) {
    throw new Error(`expected 201 from POST /tasks, got ${createResponse.status}`);
  }

  const { id } = (await createResponse.json()) as { id: string };
  console.log(`created architect task ${id}, polling /world-state for the full pipeline to complete...`);

  const deadline = Date.now() + 120_000; // Groq round-trips x3 + a real pnpm install/tsc, needs real wall time
  while (Date.now() < deadline) {
    const stateResponse = await fetch(`${CONTROL_PLANE_URL}/world-state`);
    const state = (await stateResponse.json()) as {
      tasks: Array<{ id: string; status: string }>;
      events: Array<{ taskId: string; eventType: string; payload: unknown }>;
      products: Array<{ id: string; status: string; name: string }>;
    };

    const architectTask = state.tasks.find((t) => t.id === id);
    if (architectTask?.status === 'failed') {
      throw new Error('architect task failed - check task_events for details');
    }

    const product = state.products.find((p) => p.status === 'deployed' || p.status === 'failed');
    if (product?.status === 'failed') {
      throw new Error(`product ${product.id} reached status "failed" - check task_events for compile output`);
    }
    if (product?.status === 'deployed') {
      console.log(`product "${product.name}" (${product.id}) reached status "deployed"`);

      const deployEvent = state.events.find((e) => e.eventType === 'deploy_recorded');
      const dryRun = (deployEvent?.payload as { dryRun?: boolean } | undefined)?.dryRun;
      if (dryRun !== true) {
        throw new Error(`expected the deploy to be a dry run (dryRun: true), got: ${JSON.stringify(deployEvent?.payload)}`);
      }
      console.log('dry-run check passed: no real zcli command was executed');

      const presenceResponse = await fetch(`${CONTROL_PLANE_URL}/presence`);
      const presence = (await presenceResponse.json()) as { agents: Array<{ role: string }> };
      for (const role of ['architect', 'coder', 'deployer']) {
        if (!presence.agents.some((a) => a.role === role)) {
          throw new Error(`expected a ${role} agent to be present`);
        }
      }
      console.log('presence check passed: architect, coder, and deployer are all online');
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error('pipeline did not reach a terminal product status within 120s');
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
