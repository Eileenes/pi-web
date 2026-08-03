export type GitFileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict";

export interface GitFileStatus {
  filePath: string;
  status: GitFileStatusKind;
  code: "M" | "A" | "D" | "R" | "U" | "C";
  indexStatus: string;
  worktreeStatus: string;
}

export interface GitStatusResponse {
  isGitRepository: boolean;
  repositoryRoot: string | null;
  files: GitFileStatus[];
  additions: number;
  deletions: number;
}

export interface GitFileDiffResponse {
  supported: boolean;
  status?: GitFileStatusKind;
  patch?: string;
}

export interface GitBranchInfo {
  isGitRepository: boolean;
  current: string | null;
  branches: { name: string; isCurrent: boolean }[];
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

export type GitCommandAction =
  | "stage"
  | "unstage"
  | "discard"
  | "commit"
  | "push"
  | "pull"
  | "checkout"
  | "deleteBranch";

export interface GitCommandRequest {
  action: GitCommandAction;
  cwd: string;
  /** 相对仓库根或绝对路径（服务端会解析校验） */
  paths?: string[];
  message?: string;
  branch?: string;
  create?: boolean;
  amend?: boolean;
  untracked?: boolean;
}

export interface GitCommandResponse {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  branchInfo?: GitBranchInfo;
}
