<script lang="ts">
  import type { Task, TaskIdDisplayMode } from '../../lib/types';

  interface Props {
    tasks: Task[];
    laneOrder: string[];
    bandOrder: string[];
    warnings: string[];
    statuses: string[];
    taskIdDisplay: TaskIdDisplayMode;
    onSelectTask: (taskId: string, meta?: Pick<Task, 'filePath' | 'source' | 'branch'>) => void;
  }
  let { tasks, laneOrder }: Props = $props();
</script>

<div data-testid="tree-canvas-stub">{tasks.length} tasks · {laneOrder.length} lanes</div>
