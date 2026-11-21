import pexpect,time,json,os,signal
result={'command':['npx','--yes','sagebrush@0.10.1','--sage','-q'],'events':[]}
child=None
with open('interrupt-transcript.log','w') as log:
    try:
        child=pexpect.spawn('npx',['--yes','sagebrush@0.10.1','--sage','-q'],encoding='utf-8',timeout=8,echo=False)
        child.logfile_read=log
        child.expect('sage: ')
        def command(text):
            log.write('\nSEND: '+text+'\n');log.flush();child.sendline(text);child.expect('sage: ');return child.before
        result['setup_output']=command("saved_matrix = matrix(QQ, [[1/2,1/3],[0,1]]); saved_marker = 1729; print('READY')")
        calc='sum(i*i for i in range(1000000000))'
        log.write('\nSEND: '+calc+'\n');log.flush();child.sendline(calc)
        time.sleep(1)
        result['alive_before_interrupt']=child.isalive()
        log.write('\nSEND CONTROL-C (0x03)\n');log.flush()
        start=time.monotonic();child.sendcontrol('c');child.expect('sage: ',timeout=8)
        result['seconds_to_prompt']=time.monotonic()-start
        result['interrupt_output']=child.before
        result['state_output']=command("print('STATE', saved_marker, saved_matrix[0,0], (saved_matrix*saved_matrix)[0,1])")
        result['new_math_output']=command("print('MATH', 2^10, (identity_matrix(QQ,2)-matrix(QQ,[[1/2,1/4],[1/5,1/2]])).inverse())")
        result['state_usable']='STATE 1729 1/2 1/2' in result['state_output'] and 'MATH 1024' in result['new_math_output']
        log.write('\nSEND: exit()\n');child.sendline('exit()');child.expect(pexpect.EOF,timeout=5)
        result['status']='completed'
    except Exception as e:
        result['status']='failed';result['error']=type(e).__name__+': '+str(e)
    finally:
        if child is not None:
            if child.isalive():
                # Only the PTY process group created by this probe.
                os.killpg(child.pid,signal.SIGTERM);time.sleep(0.3)
                if child.isalive():os.killpg(child.pid,signal.SIGKILL)
            child.close();result['exitstatus']=child.exitstatus;result['signalstatus']=child.signalstatus
json.dump(result,open('interrupt-result.json','w'),indent=2)
print(json.dumps(result,indent=2))
