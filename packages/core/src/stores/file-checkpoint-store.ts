import type { Shell } from "../providers/shell.js";
import type { CheckpointStore, Checkpoint } from "../checkpoint.js";

/**
 * File-based CheckpointStore.
 * Layout: {dir}/{taskId}/turn_{N}.json
 */
export class FileCheckpointStore implements CheckpointStore {
  constructor(
    private dir: string,
    private shell: Shell,
  ) {}

  async save(cp: Checkpoint): Promise<void> {
    const path = this.cpPath(cp.taskId, cp.turn);
    await this.shell.mkdir(`${this.dir}/${cp.taskId}`);
    await this.shell.writeFile(
      path,
      JSON.stringify(cp, null, 2) + "\n",
    );
  }

  async latest(taskId: string): Promise<Checkpoint | null> {
    let files: string[];
    try {
      files = await this.shell.listFiles(`${this.dir}/${taskId}`);
    } catch {
      return null;
    }

    // listFiles returns full paths; find the highest turn number
    const turnFiles = files
      .filter((f) => f.endsWith(".json") && /[/\\]turn_/.test(f))
      .sort();

    if (turnFiles.length === 0) return null;

    // Last file has the highest turn (lexicographic sort works with zero-padded names)
    const lastFile = turnFiles[turnFiles.length - 1];
    try {
      const raw = await this.shell.readFile(lastFile);
      return JSON.parse(raw) as Checkpoint;
    } catch {
      return null;
    }
  }

  private cpPath(taskId: string, turn: number): string {
    const padded = String(turn).padStart(6, "0");
    return `${this.dir}/${taskId}/turn_${padded}.json`;
  }
}
