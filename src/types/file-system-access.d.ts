type FileSystemPermissionMode = 'read' | 'readwrite';

interface FileSystemHandlePermissionDescriptor {
	mode?: FileSystemPermissionMode;
}

interface FileSystemHandle {
	queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
	requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface FileSystemDirectoryHandle {
	keys?(): {
		next(): Promise<{ value?: string; done?: boolean }>;
		return?(): Promise<{ value?: undefined; done?: boolean }>;
	};
}

interface DirectoryPickerOptions {
	id?: string;
	mode?: FileSystemPermissionMode;
	startIn?: string;
}

interface Window {
	showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}
