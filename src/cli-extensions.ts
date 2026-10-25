/** CLI commands contributed by the editing and export layers. */
export interface CliExtension {
  name: string
  usage: string
  run(pos: string[], opts: { state?: string; exportDir?: string; force: boolean; out: (v: unknown) => void }): Promise<number>
}

export const cliExtensions: CliExtension[] = []
