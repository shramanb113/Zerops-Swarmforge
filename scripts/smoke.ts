const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? 'http://localhost:3000';

interface WorldState {
  tasks: Array<{ id: string; role: string; status: string; payload: unknown }>;
  events: Array<{ taskId: string; role: string; eventType: string; payload: unknown }>;
  products: Array<{ id: string; status: string; name: string }>;
  proposals: Array<{ id: string; productId: string; taskId: string | null }>;
}

/**
 * Every assertion below is scoped to the lineage of the ONE architect task this run created:
 *
 *   architectTaskId
 *     -> architecture_proposals.taskId == architectTaskId   (written by ArchitectAgent)
 *        -> proposal.productId                              -> the product this run built
 *           -> the coder/deployer tasks whose payload.productId is that product
 *              -> the task_events on those specific task ids
 *
 * A previous version instead did `products.find(p => p.status === 'deployed')` and
 * `events.find(e => e.eventType === 'deploy_recorded')` over the newest 50 products / 100 events
 * *globally*. That matched leftover fixture rows from an earlier `pnpm test` run and printed
 * "SMOKE TEST PASSED" while this run's own product had actually failed - a false green. Nothing
 * here may match a row it has not traced back to `architectTaskId`.
 */
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

  const { id: architectTaskId } = (await createResponse.json()) as { id: string };
  console.log(`created architect task ${architectTaskId}, polling /world-state for its pipeline...`);

  const deadline = Date.now() + 300_000; // Groq round-trips x3 + a real pnpm install/tsc needs real wall time
  let lastProductId: string | undefined;

  while (Date.now() < deadline) {
    const stateResponse = await fetch(`${CONTROL_PLANE_URL}/world-state`);
    const state = (await stateResponse.json()) as WorldState;

    failIfTaskFailed(state, architectTaskId, 'architect');

    // Step 1: architect task -> its proposal. Until the architect has written one there is
    // nothing in this run's lineage to assert on yet.
    const proposal = state.proposals.find((p) => p.taskId === architectTaskId);
    if (!proposal) {
      await sleep(1000);
      continue;
    }
    const productId = proposal.productId;
    if (productId !== lastProductId) {
      console.log(`architect produced product ${productId} (proposal ${proposal.id})`);
      lastProductId = productId;
    }

    // Step 2: the coder/deployer tasks this product's pipeline spawned, matched by the product id
    // carried in their own payloads - never by role alone.
    const downstreamTaskIds = state.tasks
      .filter((t) => (t.payload as { productId?: string } | null)?.productId === productId)
      .map((t) => t.id);
    for (const taskId of downstreamTaskIds) failIfTaskFailed(state, taskId);

    // Step 3: the product row itself, by id.
    const product = state.products.find((p) => p.id === productId);
    if (!product) {
      throw new Error(`proposal ${proposal.id} references product ${productId}, which /world-state does not list`);
    }
    if (product.status === 'failed') {
      throw new Error(
        `product ${productId} ("${product.name}") reached status "failed"` +
          describeEvents(state, [architectTaskId, ...downstreamTaskIds]),
      );
    }
    if (product.status !== 'deployed') {
      await sleep(1000);
      continue;
    }

    console.log(`product "${product.name}" (${productId}) reached status "deployed"`);

    // Step 4: the deploy event, scoped to a deployer task belonging to THIS product.
    const deployEvent = state.events.find(
      (e) => e.eventType === 'deploy_recorded' && downstreamTaskIds.includes(e.taskId),
    );
    if (!deployEvent) {
      throw new Error(
        `product ${productId} is "deployed" but no deploy_recorded event exists on any of its own ` +
          `tasks (${downstreamTaskIds.join(', ') || 'none found'})`,
      );
    }
    console.log(`deploy_recorded event traced to task ${deployEvent.taskId} in this run's lineage`);

    const dryRun = (deployEvent.payload as { dryRun?: boolean }).dryRun;
    if (dryRun !== true) {
      throw new Error(`expected the deploy to be a dry run (dryRun: true), got: ${JSON.stringify(deployEvent.payload)}`);
    }
    console.log('dry-run check passed: no real zcli command was executed');

    // Also confirm the coder really produced code for this product, on this run's own task.
    const codeEvent = state.events.find(
      (e) => e.eventType === 'code_generated' && downstreamTaskIds.includes(e.taskId),
    );
    if (!codeEvent) {
      throw new Error(`no code_generated event on any task of product ${productId}`);
    }
    const files = (codeEvent.payload as { files?: string[] }).files ?? [];
    if (!files.some((f) => /(^|\/)index\.ts$/.test(f))) {
      throw new Error(`code_generated for product ${productId} lists no index.ts: ${JSON.stringify(files)}`);
    }
    console.log(`code_generated event traced to task ${codeEvent.taskId}, files: ${JSON.stringify(files)}`);

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

  throw new Error(`pipeline for architect task ${architectTaskId} did not reach a terminal product status in time`);
}

function failIfTaskFailed(state: WorldState, taskId: string, label?: string): void {
  const task = state.tasks.find((t) => t.id === taskId);
  if (task?.status === 'failed') {
    throw new Error(`${label ?? task.role} task ${taskId} failed${describeEvents(state, [taskId])}`);
  }
}

/** Surfaces the failure events on exactly these task ids, so a red run says why, not just that. */
function describeEvents(state: WorldState, taskIds: string[]): string {
  const relevant = state.events.filter(
    (e) => taskIds.includes(e.taskId) && ['task_failed', 'compile_failed'].includes(e.eventType),
  );
  if (relevant.length === 0) return '';
  return (
    '\n' +
    relevant
      .map((e) => `  [${e.role} ${e.eventType} on ${e.taskId}] ${JSON.stringify(e.payload).slice(0, 2000)}`)
      .join('\n')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
