export interface ConfluencePage {
  id: string;
  title: string;
  type: string;
  status: string;
  spaceKey?: string;
  spaceTitle?: string;
  version?: number;
  created?: string;
  lastUpdated?: string;
  authorDisplayName?: string;
  lastUpdaterDisplayName?: string;
  body?: string;
  url?: string;
  parentId?: string;
  parentTitle?: string;
}

export interface ConfluenceSpace {
  key: string;
  name: string;
  type: string;
  status: string;
  description?: string;
  url?: string;
}

export interface ConfluenceComment {
  id: string;
  body: string;
  authorDisplayName?: string;
  created?: string;
  updated?: string;
}

export interface ConfluenceVersion {
  number: number;
  message?: string;
  authorDisplayName?: string;
  when?: string;
  minorEdit: boolean;
}

export interface ConfluenceSearchResult {
  total: number;
  pages: ConfluencePage[];
}
