declare module 'spotify-url-info' {
  export default function(fetchFn: typeof fetch): {
    getTracks(url: string): Promise<Array<{ name: string; artist?: string; artists?: Array<{ name: string }>; duration?: number; previewUrl?: string }>>;
    getData(url: string): Promise<{ name: string; artist?: string; artists?: Array<{ name: string }>; duration?: number; previewUrl?: string }>;
  };
}

declare module 'yt-search' {
  interface VideoSearchResult {
    type: 'video';
    videoId: string;
    url: string;
    title: string;
    description: string;
    image: string;
    thumbnail: string;
    seconds: number;
    timestamp: string;
    duration: { toString(): string; seconds: number; timestamp: string };
    ago: string;
    views: number;
    author: { name: string; url: string };
  }

  interface SearchResult {
    all: any[];
    videos: VideoSearchResult[];
    playlists: any[];
    accounts: any[];
  }

  function ytSearch(query: string | { search?: string; query?: string; listId?: string }): Promise<SearchResult>;
  namespace ytSearch {
    function search(options: { query?: string; search?: string }): Promise<SearchResult>;
  }
  export default ytSearch;
}
