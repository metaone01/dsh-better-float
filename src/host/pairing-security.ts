import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

async function windowsAcl(path: string, protect: boolean): Promise<void> {
  const source = `
$ErrorActionPreference='Stop'
$target=$env:DSH_BF_PAIRING_TARGET
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
${protect ? `
$existing=[System.IO.Directory]::GetAccessControl($target)
if($existing.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'Unexpected credential owner'}
$acl=[System.Security.AccessControl.DirectorySecurity]::new()
# Do not rewrite the already-verified owner: changing it requires extra privileges.
$acl.SetAccessRuleProtection($true,$false)
foreach($identity in @($sid,$systemSid)) {
  $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
}
[System.IO.Directory]::SetAccessControl($target,$acl)
` : ''}
$checked=if([System.IO.Directory]::Exists($target)){[System.IO.Directory]::GetAccessControl($target)}else{[System.IO.File]::GetAccessControl($target)}
if($checked.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'Unexpected credential owner'}
$rules=$checked.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])
if($rules.Count -eq 0){throw 'No credential permissions'}
foreach($rule in $rules) {
 if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid.Value,$systemSid.Value)){throw 'Broad credential permissions'}
}
`
  try {
    await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{
      env:{...process.env,DSH_BF_PAIRING_TARGET:path},windowsHide:true,timeout:5000,maxBuffer:16384,
    })
  }catch{throw new Error('Credential ACL could not be applied or verified')}
}

/** Only call for the companion-owned credential directory, never a profile root. */
export async function protectPairingDirectory(directory: string): Promise<void> {
  await mkdir(directory,{recursive:true,mode:0o700})
  const info = await lstat(directory)
  if(!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid credential directory')
  if(process.platform==='win32') await windowsAcl(directory,true)
  else if((info.mode & 0o077)!==0 || info.uid!==process.getuid?.()) throw new Error('Unsafe credential directory permissions')
}

export async function readPrivatePairing(file: string): Promise<unknown> {
  const parent = await lstat(dirname(file))
  const info = await lstat(file)
  if(parent.isSymbolicLink() || !parent.isDirectory() || info.isSymbolicLink() || !info.isFile() || info.size>8192) throw new Error('Invalid credential file')
  if(process.platform==='win32') await Promise.all([windowsAcl(dirname(file),false),windowsAcl(file,false)])
  else if((info.mode & 0o077)!==0 || (parent.mode & 0o077)!==0 || info.uid!==process.getuid?.() || parent.uid!==info.uid) {
    throw new Error('Unsafe credential file permissions')
  }
  return JSON.parse(await readFile(file,'utf8')) as unknown
}
