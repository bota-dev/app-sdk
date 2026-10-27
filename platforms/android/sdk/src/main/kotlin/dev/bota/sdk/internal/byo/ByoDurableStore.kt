package dev.bota.sdk.internal.byo

import java.io.File
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardCopyOption.*
import java.nio.file.StandardOpenOption.*
import java.nio.file.attribute.PosixFilePermissions
import java.util.UUID

internal class ByoDurableStore(val root: File): AutoCloseable {
    private val lease: FileChannel
    private val owner: java.nio.channels.FileLock
    init {
        val created=mutableListOf<File>();var ancestor=root
        while(!Files.exists(ancestor.toPath(),NOFOLLOW_LINKS)) {
            created.add(ancestor);ancestor=ancestor.parentFile ?: throw ByoException("persistence")
        }
        Files.createDirectories(root.toPath())
        require(Files.isDirectory(root.toPath(),NOFOLLOW_LINKS))
        Files.setPosixFilePermissions(root.toPath(),PosixFilePermissions.fromString("rwx------"))
        flushDirectory(root);flushDirectory(requireNotNull(root.parentFile))
        created.asReversed().forEach {flushDirectory(requireNotNull(it.parentFile))}
        lease=FileChannel.open(File(root,"lease").toPath(),CREATE,WRITE,NOFOLLOW_LINKS)
        try {owner=lease.tryLock() ?: throw ByoException("operation_in_progress")}
        catch(error: Throwable) {lease.close();throw error}
    }
    override fun close() {try {owner.release()} finally {lease.close()}}
    private fun path(name: String): File {
        require(name in setOf("documents","state","ciphertext","segment"));return File(root,name)
    }
    fun load(name: String): ByteArray? {
        val path=path(name).toPath()
        if(!Files.exists(path,NOFOLLOW_LINKS)) return null
        require(Files.isRegularFile(path,NOFOLLOW_LINKS) && Files.size(path)<=32768)
        return Files.readAllBytes(path).also {require(it.size<=32768)}
    }
    fun save(name: String, bytes: ByteArray) {
        require(bytes.size<=32768)
        val target=path(name).toPath();val tmp=File(root,UUID.randomUUID().toString()+".tmp").toPath()
        try {
            Files.createFile(tmp,PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
            FileChannel.open(tmp,WRITE,NOFOLLOW_LINKS).use { channel ->
                val buffer=java.nio.ByteBuffer.wrap(bytes);while(buffer.hasRemaining()) channel.write(buffer);channel.force(true)
            }
            Files.move(tmp,target,ATOMIC_MOVE,REPLACE_EXISTING);flushDirectory(root)
            check(load(name)?.contentEquals(bytes)==true)
        } finally {Files.deleteIfExists(tmp)}
    }
    fun ciphertext(): File=path("ciphertext")
    fun createCiphertext(name: String="ciphertext"): FileChannel {
        val path=path(name).toPath()
        val channel=FileChannel.open(path,CREATE,WRITE,TRUNCATE_EXISTING,NOFOLLOW_LINKS)
        Files.setPosixFilePermissions(path,PosixFilePermissions.fromString("rw-------"));return channel
    }
    fun removeCiphertext() {Files.deleteIfExists(ciphertext().toPath());Files.deleteIfExists(path("segment").toPath());flushDirectory(root)}
    private fun flushDirectory(directory: File) {FileChannel.open(directory.toPath(),READ,NOFOLLOW_LINKS).use {it.force(true)}}
}
