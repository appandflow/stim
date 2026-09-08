export function reconstructCommandEvidence(runner, stamped) {
  const started = new Map();
  const taskCommands = new Map();
  const taskQueries = new Map();
  const commands = [];
  const activities = [];
  const completedEvents = [];
  const complete = (id, item, record, offset) => {
    const begin = started.get(id);
    commands.push({
      id,
      command: item.command ?? begin?.command ?? null,
      startedAt: begin?.at ?? null,
      endedAt: record.arrivedAt,
      elapsedSeconds: begin ? (Date.parse(record.arrivedAt) - Date.parse(begin.at)) / 1000 : null,
      parallelTimingAmbiguous: !begin,
      exitCode: item.exit_code,
      startEventOffset: begin?.offset ?? null,
      endEventOffset: offset,
      output: item.aggregated_output ?? '',
    });
    completedEvents.push(item);
    started.delete(id);
  };
  for (const [offset, record] of stamped.entries()) {
    let event;
    try {
      event = JSON.parse(record.line);
    } catch {
      continue;
    }
    if (runner === 'claude') {
      for (const block of event.message?.content ?? []) {
        if (event.type === 'assistant' && block.type === 'tool_use') {
          if (block.name === 'Bash') {
            started.set(block.id, {
              offset,
              at: record.arrivedAt,
              command: block.input?.command ?? null,
              backgroundRequested: block.input?.run_in_background === true,
            });
          } else if (['TaskOutput', 'BashOutput'].includes(block.name) && taskCommands.has(block.input?.task_id)) {
            taskQueries.set(block.id, block.input.task_id);
          } else {
            activities.push({
              id: block.id,
              command: `tool:${block.name} ${JSON.stringify(block.input ?? {})}`,
              startedAt: record.arrivedAt,
              endedAt: record.arrivedAt,
              completedAt: null,
            });
          }
        }
        if (event.type !== 'user' || block.type !== 'tool_result') continue;
        const activity = activities.find((entry) => entry.id === block.tool_use_id);
        if (activity) activity.completedAt = record.arrivedAt;
        const result = event.tool_use_result ?? {};
        const taskId = taskQueries.get(block.tool_use_id);
        if (taskId) {
          taskQueries.delete(block.tool_use_id);
          const task = result.task;
          const commandId = taskCommands.get(taskId);
          if (
            commandId &&
            started.has(commandId) &&
            result.retrieval_status === 'success' &&
            task?.task_id === taskId &&
            task.task_type === 'local_bash' &&
            ['completed', 'failed', 'stopped'].includes(task.status) &&
            Number.isInteger(task.exitCode) &&
            !block.is_error &&
            !result.is_error
          ) {
            complete(
              commandId,
              {
                id: commandId,
                type: 'command_execution',
                command: started.get(commandId).command,
                aggregated_output: typeof task.output === 'string' ? task.output : '',
                exit_code: task.status === 'completed' ? task.exitCode : task.exitCode || 1,
              },
              record,
              offset,
            );
            taskCommands.delete(taskId);
          }
          continue;
        }
        const begin = started.get(block.tool_use_id);
        if (!begin) continue;
        const output = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? result);
        if (result.backgroundTaskId || (begin.backgroundRequested && !Number.isInteger(result.exit_code))) {
          begin.output = output;
          if (typeof result.backgroundTaskId === 'string') taskCommands.set(result.backgroundTaskId, block.tool_use_id);
          continue;
        }
        complete(
          block.tool_use_id,
          {
            id: block.tool_use_id,
            type: 'command_execution',
            command: begin.command,
            aggregated_output: output,
            exit_code: Number.isInteger(result.exit_code)
              ? result.exit_code
              : block.is_error || result.is_error || result.interrupted
                ? 1
                : 0,
          },
          record,
          offset,
        );
      }
      continue;
    }
    const item = event.item;
    const executableActivity = item?.type && !['command_execution', 'reasoning', 'agent_message'].includes(item.type);
    if (event.type === 'item.started' && executableActivity) {
      activities.push({
        id: item.id,
        command: `tool:${item.type} ${JSON.stringify(item.changes ?? item)}`,
        startedAt: record.arrivedAt,
        endedAt: record.arrivedAt,
        completedAt: null,
      });
    }
    if (event.type === 'item.completed' && executableActivity) {
      const activity = activities.find((entry) => entry.id === item?.id);
      if (activity) activity.completedAt = record.arrivedAt;
      else
        activities.push({
          id: item.id,
          command: `tool:${item.type} ${JSON.stringify(item.changes ?? item)}`,
          startedAt: null,
          endedAt: record.arrivedAt,
          completedAt: record.arrivedAt,
        });
    }
    if (event.type === 'item.started' && item?.type === 'command_execution') {
      started.set(item.id, { offset, at: record.arrivedAt, command: item.command });
    }
    if (event.type === 'item.completed' && item?.type === 'command_execution') {
      complete(item.id, item, record, offset);
    }
  }
  for (const [id, begin] of started) {
    commands.push({
      id,
      command: begin.command,
      startedAt: begin.at,
      endedAt: null,
      elapsedSeconds: null,
      parallelTimingAmbiguous: true,
      exitCode: null,
      startEventOffset: begin.offset,
      endEventOffset: null,
      output: begin.output ?? '',
    });
  }
  return { commands, activities, completedEvents };
}
