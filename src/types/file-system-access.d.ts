type FileSystemPermissionMode = 'read' | 'readwrite';

interface FileSystemHandlePermissionDescriptor {
	mode?: FileSystemPermissionMode;
}

interface FileSystemHandle {
	queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
	requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface DirectoryPickerOptions {
	id?: string;
	mode?: FileSystemPermissionMode;
	startIn?: string;
}

interface Window {
	showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}
